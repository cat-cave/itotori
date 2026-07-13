import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface PaginationProps {
  /** Zero-indexed current page. */
  page: number;
  /** Total number of pages (must be >= 1). */
  pageCount: number;
  /** Advance the page cursor backwards. Caller clamps the cursor. */
  onPrevious: () => void;
  /** Advance the page cursor forwards. Caller clamps the cursor. */
  onNext: () => void;
  /** Accessible label for the nav region. */
  label?: string;
  /**
   * Total number of items across the full collection (rendered after the
   * `page-of-N` status when provided — e.g. `Page 2 of 5 · 42 items`).
   * Omit to render the plain `page-of-N` form, the shape
   * `OffsetPager`-backed server pages bind to.
   */
  totalItems?: number;
  /** Singular noun used for the count (default: `"item"`). */
  itemName?: string;
  className?: string;
}

/**
 * Pagination — a reusable prev/next pager with a `page-of-N` status. Lives in
 * the navigation group because it advances a screen cursor; aligned with the
 * server-side `OffsetPager` (apps/itotori/src/api-client.ts) so the same
 * component renders both client-side collections and future server-paginated
 * surfaces. Disabled at bounds; the prev/next buttons remain
 * real `<button>`s so keyboard + screen-reader users get focus + `aria-label`
 * semantics, not div-arrows.
 */
export function Pagination({
  page,
  pageCount,
  onPrevious,
  onNext,
  label,
  totalItems,
  itemName = "item",
  className,
}: PaginationProps): ReactNode {
  const safePageCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(0, page), safePageCount - 1);
  const atStart = safePage <= 0;
  const atEnd = safePage >= safePageCount - 1;
  return (
    <nav className={cx("itotori-pagination", className)} aria-label={label}>
      <button
        type="button"
        className="itotori-pagination__prev"
        onClick={onPrevious}
        disabled={atStart}
        aria-label="Previous page"
      >
        Previous
      </button>
      <span className="itotori-pagination__status" aria-live="polite">
        Page {safePage + 1} of {safePageCount}
        {totalItems !== undefined && (
          <>
            {" · "}
            {totalItems} {totalItems === 1 ? itemName : `${itemName}s`}
          </>
        )}
      </span>
      <button
        type="button"
        className="itotori-pagination__next"
        onClick={onNext}
        disabled={atEnd}
        aria-label="Next page"
      >
        Next
      </button>
    </nav>
  );
}
