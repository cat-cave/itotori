// fnd-spa-shell — shared loading / empty / error surfaces for the SPA
// screens. Every screen renders one of these while its typed `ApiResource`
// is `loading` or has settled `empty` / `error`, so an unqueried or failed
// read is NEVER shown as a confirmed-empty panel (the same distinction the
// deleted HTML dashboard's four-state panel model drew).

import type { ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import type { ApiClientError } from "../api-client.js";

export function ShellHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <header className="itotori-shell__header">
      <div>
        <p className="itotori-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function LoadingState({ label }: { label: string }): ReactNode {
  return (
    <Panel title="Loading" eyebrow="Please wait">
      <p role="status">{label}</p>
    </Panel>
  );
}

export function EmptyState({ title, message }: { title: string; message: string }): ReactNode {
  return (
    <Panel title={title} eyebrow="Nothing here yet">
      <p>{message}</p>
    </Panel>
  );
}

export function ErrorState({ title, error }: { title: string; error: ApiClientError }): ReactNode {
  const hasTyped = error.code !== null && error.message !== null;
  return (
    <Panel title={title} eyebrow="Unavailable" tone="sakura">
      <p role="alert">This view could not load.</p>
      {hasTyped ? (
        <p className="itotori-api-error" data-api-error-code={error.code ?? undefined}>
          <Badge status="failed">{error.code}</Badge> {error.message}
        </p>
      ) : (
        <p className="itotori-api-error" data-api-error-code="unavailable">
          {`Route ${error.routeId} failed with status ${error.status} (no typed error body).`}
        </p>
      )}
    </Panel>
  );
}
