import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../cx.js";
import { Badge } from "../core/Badge.js";
import { Panel } from "../layout/Panel.js";

export type WikiEntryKind = "character" | "term" | "scene" | "source_unit";

export interface WikiEntryFact {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export interface WikiEntryCrossRef {
  id: string;
  label: ReactNode;
  href?: string | null;
  kind?: WikiEntryKind | string;
}

export interface WikiEntryProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  kind: WikiEntryKind | string;
  identifier?: ReactNode;
  locale?: ReactNode;
  status?: string | null;
  stale?: boolean;
  facts?: readonly WikiEntryFact[];
  crossRefs?: readonly WikiEntryCrossRef[];
  children?: ReactNode;
}

/**
 * WikiEntry — reusable profile shell for character / term / scene entries.
 *
 * The host supplies read-model content and addressable hrefs. This component
 * standardizes the profile chrome, status badge, facts, and cross-reference
 * list without knowing any project-specific vocabulary.
 */
export function WikiEntry({
  title,
  kind,
  identifier,
  locale,
  status = null,
  stale = false,
  facts = [],
  crossRefs = [],
  children,
  className,
  ...rest
}: WikiEntryProps): ReactNode {
  const lamps =
    status !== null ? (
      <Badge status={stale ? "stale" : status} {...(stale ? { tone: "neutral" as const } : {})}>
        {stale ? "stale" : status}
      </Badge>
    ) : undefined;

  return (
    <Panel
      {...rest}
      title={title}
      eyebrow={locale === undefined ? kind : `${kind} · ${locale}`}
      lamps={lamps}
      className={cx("itotori-wiki-entry", className)}
      data-wiki-kind={kind}
    >
      {identifier !== undefined && <code className="itotori-wiki-entry__id">{identifier}</code>}
      {facts.length > 0 && (
        <dl className="itotori-wiki-entry__facts" aria-label="Wiki entry facts">
          {facts.map((fact, index) => (
            <div key={index} className="itotori-wiki-entry__fact">
              <dt>{fact.label}</dt>
              <dd className={fact.mono === true ? "itotori-wiki-entry__fact-value--mono" : ""}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="itotori-wiki-entry__body">{children}</div>
      {crossRefs.length > 0 && (
        <nav className="itotori-wiki-entry__crossrefs" aria-label="Cross references">
          {crossRefs.map((ref) =>
            ref.href === undefined || ref.href === null ? (
              <span
                key={ref.id}
                className="itotori-wiki-entry__crossref"
                data-crossref-kind={ref.kind}
              >
                {ref.label}
              </span>
            ) : (
              <a
                key={ref.id}
                className="itotori-wiki-entry__crossref"
                data-crossref-kind={ref.kind}
                href={ref.href}
              >
                {ref.label}
              </a>
            ),
          )}
        </nav>
      )}
    </Panel>
  );
}
