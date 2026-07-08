import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface DataTableColumn<Row> {
  /** Stable column key. */
  key: string;
  /** Header label (rendered as a tracked-uppercase th label). */
  header: ReactNode;
  align?: "start" | "end" | "center";
  /** Cell renderer; receives the row. */
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: ReadonlyArray<DataTableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  /** Stable per-row key. */
  getRowKey: (row: Row, index: number) => string;
  /** Optional row click → addressable navigation. */
  onRowActivate?: (row: Row) => void;
  /** Caption for assistive tech. */
  caption?: string;
  emptyLabel?: ReactNode;
  className?: string;
}

/**
 * DataTable — the hairline-divider grid, itotori's signature data motif. Night
 * cells over a divider-coloured container with a 1px gap, so the seams read as
 * thin dividers (no drawn rules). Rows are optionally activatable for deep,
 * addressable navigation.
 */
export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  onRowActivate,
  caption,
  emptyLabel = "No rows.",
  className,
}: DataTableProps<Row>): ReactNode {
  return (
    <div className={cx("itotori-datatable", className)}>
      <table className="itotori-datatable__table">
        {caption && <caption className="itotori-datatable__caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cx("itotori-datatable__th", col.align && `itotori-align-${col.align}`)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="itotori-datatable__empty" colSpan={columns.length}>
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={getRowKey(row, index)}
                className={cx(
                  "itotori-datatable__row",
                  onRowActivate && "itotori-datatable__row--activatable",
                )}
                {...(onRowActivate
                  ? {
                      tabIndex: 0,
                      role: "button",
                      onClick: () => onRowActivate(row),
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowActivate(row);
                        }
                      },
                    }
                  : {})}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cx(
                      "itotori-datatable__td",
                      col.align && `itotori-align-${col.align}`,
                    )}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
