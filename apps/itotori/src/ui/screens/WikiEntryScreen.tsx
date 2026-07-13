// Wiki — the play tester's browsable, editable view of the shared context brain.
//
// Node 6 owns the durable, versioned context entries. This screen deliberately
// reads the generic node-9 projections (`wiki.list` / `wiki.show` /
// `wiki.history`) instead of the retired character-and-term-only facade. A
// direct save is a context correction (`wiki.edit`), so it appends a canonical
// version and schedules the existing node-8 invalidation/redraft flywheel;
// there is no reviewer or approval control here.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Badge, DataTable, NavPills, Pagination, Panel, type NavPillItem } from "@itotori/ds";
import type {
  WikiContextCitation,
  WikiContextEntriesReadModel,
  WikiContextEntry,
  WikiContextEntryHistoryReadModel,
  WikiContextEntryKind,
} from "@itotori/db";
import type { ApiWikiEditResponse } from "../../api-schema.js";
import { hrefForAddressable } from "../addressable-routing.js";
import { apiClient } from "../client.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export const wikiRoutePathRegex = /^\/wiki\/?$/u;

/** Keep the index useful without concealing any run-generated context kind. */
const WIKI_ENTRY_INDEX_LIMIT = 100;

const wikiKindLabel: Readonly<Record<WikiContextEntryKind, string>> = {
  scene: "Scene",
  character: "Character",
  route: "Route",
  term: "Term",
  speaker: "Speaker",
  glossary: "Glossary",
  style: "Style",
  note: "Note",
};

const wikiAddKinds = ["note", "glossary", "style"] as const;
type WikiAddKind = (typeof wikiAddKinds)[number];

type WikiEditSuccess = {
  contextArtifactId: string;
  versionId: string;
  invalidatedArtifactIds: string[];
  affectedUnitIds: string[];
  jobId: string;
};

export type WikiEntryRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
  /** Retained for character/term addressable links owned by the shell. */
  focusKind: "character" | "term" | null;
  /** A generic context-artifact id when supplied by a future wiki deep-link. */
  focusEntryId: string | null;
};

/** Parse the stable root wiki route and its optional branch/entry scope. */
export function parseWikiRoute(pathname: string, search: string): WikiEntryRouteParams | null {
  if (!wikiRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  return {
    projectId: nonEmpty(params.get("projectId")),
    localeBranchId: nonEmpty(params.get("localeBranchId")),
    focusKind: null,
    focusEntryId: nonEmpty(params.get("entryId")),
  };
}

/**
 * Preserve the shell's character/term deep-link contract. The generic read
 * model resolves a character through its canonical semantic data; an unknown
 * legacy link is deliberately left unselected rather than showing an
 * unrelated first entry.
 */
export function wikiRouteFromAddressable(location: {
  kind: "character" | "term";
  id: string;
  projectId: string | null;
  localeBranchId: string | null;
}): WikiEntryRouteParams {
  return {
    projectId: location.projectId,
    localeBranchId: location.localeBranchId,
    focusKind: location.kind,
    focusEntryId: entryIdFor(location.kind, location.id),
  };
}

/** Retained as a stable helper for callers that own legacy addressable URLs. */
export function entryIdFor(kind: "character" | "term", id: string): string {
  return `${kind}:${id}`;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}

export function WikiEntryScreen({ route }: { route: WikiEntryRouteParams }): ReactNode {
  if (route.projectId !== null && route.localeBranchId !== null) {
    return (
      <WikiEntryForBranch
        projectId={route.projectId}
        localeBranchId={route.localeBranchId}
        focusEntryId={route.focusEntryId}
        focusKind={route.focusKind}
      />
    );
  }
  return <WikiEntryFromStatus focusEntryId={route.focusEntryId} focusKind={route.focusKind} />;
}

/** Resolve an unscoped /wiki route through the selected Studio branch. */
function WikiEntryFromStatus({
  focusEntryId,
  focusKind,
}: {
  focusEntryId: string | null;
  focusKind: WikiEntryRouteParams["focusKind"];
}): ReactNode {
  const status = useApiQuery("projects.status", {}, "wiki:project-status");
  if (status.state === "loading") {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="loading">
        <ShellHeader eyebrow="Wiki" title="Wiki" />
        <LoadingState label="Loading project context…" />
      </main>
    );
  }
  if (status.state === "error") {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="error">
        <ShellHeader eyebrow="Wiki" title="Wiki" />
        <ErrorState title="Wiki" error={status.error} />
      </main>
    );
  }
  const projectId = status.state === "ready" ? status.data.projectId : null;
  const localeBranchId = status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (projectId === null || localeBranchId === null) {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="empty">
        <ShellHeader eyebrow="Wiki" title="Wiki" />
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to browse the shared context wiki."
        />
      </main>
    );
  }
  return (
    <WikiEntryForBranch
      projectId={projectId}
      localeBranchId={localeBranchId}
      focusEntryId={focusEntryId}
      focusKind={focusKind}
    />
  );
}

function WikiEntryForBranch({
  projectId,
  localeBranchId,
  focusEntryId,
  focusKind,
}: {
  projectId: string;
  localeBranchId: string;
  focusEntryId: string | null;
  focusKind: WikiEntryRouteParams["focusKind"];
}): ReactNode {
  const [refresh, setRefresh] = useState(0);
  const [offset, setOffset] = useState(0);
  const [editSuccess, setEditSuccess] = useState<WikiEditSuccess | null>(null);
  const entries = useApiQuery(
    "wiki.list",
    {
      pathParams: { projectId, localeBranchId },
      query: { includeStale: true, limit: WIKI_ENTRY_INDEX_LIMIT, offset },
      // An empty later page is not an empty wiki: retain its pagination
      // controls so a concurrent deletion cannot strand the play tester.
      isEmpty: (model) => model.pagination.total === 0,
    },
    `wiki:list:${projectId}:${localeBranchId}:${refresh}:${offset}`,
  );

  return (
    <main
      className="itotori-shell wiki-entry"
      data-screen="wiki-entry"
      data-state={entries.state}
      data-locale-branch-id={localeBranchId}
      data-addressable-focus={focusEntryId ?? undefined}
      data-addressable-focused={focusEntryId !== null ? "true" : undefined}
      data-focus-kind={focusKind ?? undefined}
    >
      <ShellHeader eyebrow="Wiki" title="Shared context" />
      <WikiEditSuccessNotice success={editSuccess} />
      {entries.state === "loading" && <LoadingState label="Loading context entries…" />}
      {entries.state === "empty" && (
        <>
          <EmptyState
            title="Shared context"
            message="No run-generated or play-tester context entries were returned for this locale branch."
          />
          <WikiAddContextForm
            projectId={projectId}
            localeBranchId={localeBranchId}
            sourceRevisionId=""
            onAdded={(saved) => {
              setEditSuccess(saved);
              setRefresh((current) => current + 1);
            }}
          />
        </>
      )}
      {entries.state === "error" && <ErrorState title="Shared context" error={entries.error} />}
      {entries.state === "ready" && (
        <WikiEntryReady
          model={entries.data}
          focusEntryId={focusEntryId}
          focusKind={focusKind}
          refresh={refresh}
          onPreviousPage={() => {
            setOffset((current) => Math.max(0, current - WIKI_ENTRY_INDEX_LIMIT));
          }}
          onNextPage={() => {
            const nextOffset = entries.data.pagination.nextOffset;
            if (nextOffset !== null) {
              setOffset(nextOffset);
            }
          }}
          onEdited={(saved) => {
            setEditSuccess(saved);
            setRefresh((current) => current + 1);
          }}
        />
      )}
    </main>
  );
}

function WikiEntryReady({
  model,
  focusEntryId,
  focusKind,
  refresh,
  onPreviousPage,
  onNextPage,
  onEdited,
}: {
  model: WikiContextEntriesReadModel;
  focusEntryId: string | null;
  focusKind: WikiEntryRouteParams["focusKind"];
  refresh: number;
  onPreviousPage(): void;
  onNextPage(): void;
  onEdited(saved: WikiEditSuccess): void;
}): ReactNode {
  const [selectedEntryId, setSelectedEntryId] = useState(() =>
    initialSelection(model, focusEntryId, focusKind),
  );

  // A valid incoming deep link should win once. After an edit refresh, retain
  // the user's current selection when it is still present in the real list.
  useEffect(() => {
    if (focusEntryId !== null) {
      setSelectedEntryId(resolveFocusEntryId(model.entries, focusEntryId, focusKind) ?? "");
    }
  }, [focusEntryId, focusKind, model.entries]);

  const selectedEntry =
    model.entries.find((entry) => entry.contextArtifactId === selectedEntryId) ??
    (selectedEntryId === "" ? null : (model.entries[0] ?? null));
  const items: NavPillItem[] = model.entries.map((entry) => ({
    id: entry.contextArtifactId,
    label: entry.title,
    badge: wikiKindLabel[entry.kind],
  }));

  return (
    <section
      className="wiki-entry__body"
      aria-label="Context wiki entries"
      data-entry-count={model.entries.length}
      data-selected-entry-id={selectedEntry?.contextArtifactId ?? ""}
      data-selected-kind={selectedEntry?.kind ?? ""}
    >
      <Panel
        title="Context index"
        eyebrow={`${model.pagination.total} canonical entr${model.pagination.total === 1 ? "y" : "ies"}`}
        lamps={<Badge status="active">all kinds</Badge>}
      >
        <p>
          Browse context written by runs and by play testers. Stale entries remain visible so their
          provenance and downstream impact can be inspected.
        </p>
        <NavPills
          items={items}
          activeId={selectedEntry?.contextArtifactId ?? ""}
          onSelect={setSelectedEntryId}
          label="Context entries by title"
          className="wiki-entry__index"
        />
        {model.pagination.total > model.pagination.limit && (
          <Pagination
            label="Context wiki pagination"
            page={Math.floor(model.pagination.offset / model.pagination.limit)}
            pageCount={Math.max(1, Math.ceil(model.pagination.total / model.pagination.limit))}
            totalItems={model.pagination.total}
            itemName="context item"
            onPrevious={onPreviousPage}
            onNext={onNextPage}
          />
        )}
        <WikiAddContextForm
          projectId={model.filter.projectId}
          localeBranchId={model.filter.localeBranchId}
          sourceRevisionId={selectedEntry?.sourceRevisionId ?? ""}
          onAdded={onEdited}
        />
      </Panel>
      {selectedEntry === null ? (
        <EmptyState
          title={focusEntryId === null ? "No entry selected" : "Context link unavailable"}
          message={
            focusEntryId === null
              ? "This locale branch has no context entries."
              : "The requested wiki link does not resolve to a canonical context entry in this locale branch."
          }
        />
      ) : (
        <WikiContextDetail entry={selectedEntry} refresh={refresh} onEdited={onEdited} />
      )}
    </section>
  );
}

function WikiContextDetail({
  entry,
  refresh,
  onEdited,
}: {
  entry: WikiContextEntry;
  refresh: number;
  onEdited(saved: WikiEditSuccess): void;
}): ReactNode {
  const identity = `${entry.projectId}:${entry.localeBranchId}:${entry.contextArtifactId}:${refresh}`;
  const pathParams = {
    projectId: entry.projectId,
    localeBranchId: entry.localeBranchId,
    contextArtifactId: entry.contextArtifactId,
  };
  const detail = useApiQuery("wiki.show", { pathParams }, `wiki:show:${identity}`);
  const history = useApiQuery("wiki.history", { pathParams }, `wiki:history:${identity}`);

  if (detail.state === "loading" || history.state === "loading") {
    return <LoadingState label="Loading canonical content, provenance, and history…" />;
  }
  if (detail.state === "error") {
    return <ErrorState title="Wiki entry" error={detail.error} />;
  }
  if (history.state === "error") {
    return <ErrorState title="Wiki history" error={history.error} />;
  }
  if (detail.state === "empty" || history.state === "empty") {
    return (
      <EmptyState
        title="Wiki entry unavailable"
        message="The selected context entry no longer has a readable canonical projection."
      />
    );
  }
  return (
    <WikiContextDetailReady entry={detail.data.entry} history={history.data} onEdited={onEdited} />
  );
}

function WikiContextDetailReady({
  entry,
  history,
  onEdited,
}: {
  entry: WikiContextEntry;
  history: WikiContextEntryHistoryReadModel;
  onEdited(saved: WikiEditSuccess): void;
}): ReactNode {
  return (
    <section
      className="wiki-entry__detail"
      aria-label="Selected context entry"
      data-context-artifact-id={entry.contextArtifactId}
      data-wiki-kind={entry.kind}
      data-head-version-id={entry.headVersionId ?? ""}
    >
      <Panel
        title={entry.title}
        eyebrow={wikiKindLabel[entry.kind]}
        lamps={<Badge status={entry.status}>{entry.status}</Badge>}
      >
        <dl className="wiki-entry__facts">
          <div>
            <dt>Canonical entry</dt>
            <dd>
              <code>{entry.contextArtifactId}</code>
            </dd>
          </div>
          <div>
            <dt>Head version</dt>
            <dd>
              <code>{entry.headVersionId ?? "No canonical version yet"}</code>
            </dd>
          </div>
          <div>
            <dt>Versions</dt>
            <dd>{entry.versionCount}</dd>
          </div>
          <div>
            <dt>Source revision</dt>
            <dd>
              <code>{entry.sourceRevisionId}</code>
            </dd>
          </div>
        </dl>
      </Panel>
      <WikiContentPanel entry={entry} />
      <WikiProvenancePanel entry={entry} />
      <WikiCitationsPanel entry={entry} />
      <WikiImpactPanel entry={entry} />
      <WikiHistoryPanel history={history} />
      <WikiEditForm
        key={`${entry.contextArtifactId}:${entry.headVersionId ?? "new"}`}
        entry={entry}
        onEdited={onEdited}
      />
    </section>
  );
}

function WikiContentPanel({ entry }: { entry: WikiContextEntry }): ReactNode {
  return (
    <Panel title="Content" eyebrow="Canonical head">
      <p className="wiki-entry__body" data-wiki-content={entry.contextArtifactId}>
        {entry.body}
      </p>
      <details>
        <summary>Structured context data</summary>
        <pre>{formatJson(entry.data)}</pre>
      </details>
    </Panel>
  );
}

function WikiProvenancePanel({ entry }: { entry: WikiContextEntry }): ReactNode {
  const provenance = entry.provenance;
  return (
    <Panel title="Provenance" eyebrow="How this enrichment was written">
      <DataTable
        caption="Canonical provenance"
        columns={[
          { key: "producer", header: "Producer", render: () => provenance.producedByAgent ?? "—" },
          { key: "tool", header: "Tool", render: () => provenance.producedByTool ?? "—" },
          { key: "version", header: "Version", render: () => provenance.producerVersion },
          { key: "origin", header: "Origin", render: () => provenance.origin ?? "—" },
          { key: "run", header: "Run", render: () => provenance.runId ?? "—" },
          { key: "actor", header: "Actor", render: () => provenance.createdByUserId ?? "—" },
        ]}
        rows={[provenance]}
        getRowKey={() => entry.contextArtifactId}
      />
      <details>
        <summary>Full provenance payload</summary>
        <pre>{formatJson(provenance.provenance)}</pre>
      </details>
    </Panel>
  );
}

function WikiCitationsPanel({ entry }: { entry: WikiContextEntry }): ReactNode {
  return (
    <Panel
      title="Citations"
      eyebrow={`${entry.citations.length} source witness${entry.citations.length === 1 ? "" : "es"}`}
    >
      <DataTable
        caption="Cited source units"
        columns={[
          {
            key: "unit",
            header: "Unit",
            render: (citation) => <CitationJump citation={citation} entry={entry} />,
          },
          { key: "citation", header: "Citation", render: (citation) => citation.citation },
          {
            key: "revision",
            header: "Source revision",
            render: (citation) => citation.sourceRevisionId,
          },
          {
            key: "hash",
            header: "Source hash",
            render: (citation) => <code>{citation.sourceHash}</code>,
          },
        ]}
        rows={entry.citations}
        getRowKey={(citation) =>
          `${citation.bridgeUnitId}:${citation.sourceHash}:${citation.citation}`
        }
        emptyLabel="No source witnesses were persisted for this entry."
      />
    </Panel>
  );
}

function CitationJump({
  citation,
  entry,
}: {
  citation: WikiContextCitation;
  entry: WikiContextEntry;
}): ReactNode {
  return (
    <a
      href={hrefForAddressable({
        kind: "unit",
        id: citation.bridgeUnitId,
        projectId: entry.projectId,
        localeBranchId: entry.localeBranchId,
      })}
      data-wiki-scene-jump={citation.bridgeUnitId}
    >
      {citation.bridgeUnitId}
    </a>
  );
}

function WikiImpactPanel({ entry }: { entry: WikiContextEntry }): ReactNode {
  const { impact } = entry;
  return (
    <Panel title="Impact" eyebrow="Next ContextPacket and redraft scope">
      <p data-wiki-affected-unit-count={impact.affectedUnitIds.length}>
        {impact.affectedUnitIds.length === 0
          ? "No affected units were recorded for this version."
          : `${impact.affectedUnitIds.length} unit(s) resolve this canonical context into their next ContextPacket.`}
      </p>
      {impact.affectedUnitIds.length > 0 && (
        <ul aria-label="Affected units">
          {impact.affectedUnitIds.map((unitId) => (
            <li key={unitId}>
              <code>{unitId}</code>
            </li>
          ))}
        </ul>
      )}
      <dl className="wiki-entry__facts">
        <div>
          <dt>Invalidation reason</dt>
          <dd>{impact.invalidatedReason ?? "No invalidation is currently recorded."}</dd>
        </div>
        <div>
          <dt>Invalidated at</dt>
          <dd>{formatDate(impact.invalidatedAt)}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function WikiHistoryPanel({ history }: { history: WikiContextEntryHistoryReadModel }): ReactNode {
  return (
    <Panel
      title="History"
      eyebrow={`${history.versions.length} immutable version${history.versions.length === 1 ? "" : "s"}`}
    >
      <DataTable
        caption="Canonical version history"
        columns={[
          {
            key: "version",
            header: "Version",
            render: (version) => <code>{version.contextEntryVersionId}</code>,
          },
          {
            key: "head",
            header: "Head",
            render: (version) => (version.isHead ? <Badge status="active">current</Badge> : ""),
          },
          { key: "body", header: "Content", render: (version) => version.body },
          {
            key: "origin",
            header: "Origin",
            render: (version) => version.provenance.origin ?? "—",
          },
          {
            key: "impact",
            header: "Affected units",
            render: (version) => version.impact.affectedUnitIds.length,
          },
          { key: "created", header: "Created", render: (version) => formatDate(version.createdAt) },
        ]}
        rows={history.versions}
        getRowKey={(version) => version.contextEntryVersionId}
        emptyLabel="No immutable versions were returned for this canonical entry."
      />
    </Panel>
  );
}

function WikiAddContextForm({
  projectId,
  localeBranchId,
  sourceRevisionId: initialSourceRevisionId,
  onAdded,
}: {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  onAdded(saved: WikiEditSuccess): void;
}): ReactNode {
  const [kind, setKind] = useState<WikiAddKind>("note");
  const [sourceRevisionId, setSourceRevisionId] = useState(initialSourceRevisionId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [affectedUnits, setAffectedUnits] = useState("");
  const [outcome, setOutcome] = useState<WikiEditFormState>({ state: "idle" });
  const affectedUnitIds = lines(affectedUnits);
  const canAdd =
    sourceRevisionId.trim().length > 0 &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    reason.trim().length > 0 &&
    affectedUnitIds.length > 0 &&
    outcome.state !== "saving";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAdd) {
      return;
    }
    setOutcome({ state: "saving" });
    const result = await apiClient.request("wiki.add", {
      pathParams: { projectId, localeBranchId },
      body: {
        sourceRevisionId: sourceRevisionId.trim(),
        kind,
        title: title.trim(),
        body: body.trim(),
        reason: reason.trim(),
        affectedUnitIds,
      },
    });
    if (result.state === "ready") {
      onAdded({
        contextArtifactId: result.data.contextArtifactId,
        ...editSuccessFromResponse(result.data),
      });
      return;
    }
    if (result.state === "error") {
      setOutcome({
        state: "error",
        message:
          result.error.message ??
          `Adding context failed with status ${String(result.error.status)}.`,
      });
      return;
    }
    setOutcome({ state: "error", message: "Adding context returned no canonical version." });
  }

  return (
    <section aria-label="Add shared context">
      <h3>Add context</h3>
      <p>
        Write a new shared note, glossary fact, or style instruction directly into the context
        brain.
      </p>
      <form aria-label="Add shared context" onSubmit={(event) => void submit(event)}>
        <p>
          <label htmlFor="wiki-add-kind">Context kind</label>
          <select
            id="wiki-add-kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as WikiAddKind)}
          >
            {wikiAddKinds.map((value) => (
              <option key={value} value={value}>
                {wikiKindLabel[value]}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="wiki-add-source-revision">Source revision</label>
          <input
            id="wiki-add-source-revision"
            name="sourceRevisionId"
            value={sourceRevisionId}
            onChange={(event) => setSourceRevisionId(event.target.value)}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-add-title">Entry title</label>
          <input
            id="wiki-add-title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-add-body">Canonical content</label>
          <textarea
            id="wiki-add-body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-add-reason">Why this context matters</label>
          <textarea
            id="wiki-add-reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-add-affected-units">Affected units (one per line)</label>
          <textarea
            id="wiki-add-affected-units"
            name="affectedUnits"
            value={affectedUnits}
            onChange={(event) => setAffectedUnits(event.target.value)}
            rows={3}
          />
        </p>
        <button type="submit" disabled={!canAdd}>
          {outcome.state === "saving" ? "Adding canonical context…" : "Add canonical context"}
        </button>
      </form>
      {outcome.state === "error" && <p role="alert">{outcome.message}</p>}
    </section>
  );
}

type WikiEditFormState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "error"; message: string };

function WikiEditForm({
  entry,
  onEdited,
}: {
  entry: WikiContextEntry;
  onEdited(saved: WikiEditSuccess): void;
}): ReactNode {
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [reason, setReason] = useState("");
  const [affectedUnits, setAffectedUnits] = useState(entry.impact.affectedUnitIds.join("\n"));
  const [outcome, setOutcome] = useState<WikiEditFormState>({ state: "idle" });
  const canSave =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    reason.trim().length > 0 &&
    outcome.state !== "saving";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    setOutcome({ state: "saving" });
    const affectedUnitIds = lines(affectedUnits);
    const result = await apiClient.request("wiki.edit", {
      pathParams: {
        projectId: entry.projectId,
        localeBranchId: entry.localeBranchId,
        contextArtifactId: entry.contextArtifactId,
      },
      body: {
        body: body.trim(),
        reason: reason.trim(),
        ...(title.trim() === entry.title ? {} : { title: title.trim() }),
        ...(affectedUnitIds.length === 0 ? {} : { affectedUnitIds }),
      },
    });
    if (result.state === "ready") {
      const saved = editSuccessFromResponse(result.data);
      onEdited({ contextArtifactId: result.data.contextArtifactId, ...saved });
      return;
    }
    if (result.state === "error") {
      setOutcome({
        state: "error",
        message:
          result.error.message ?? `Wiki edit failed with status ${String(result.error.status)}.`,
      });
      return;
    }
    setOutcome({ state: "error", message: "Wiki edit returned no canonical version." });
  }

  return (
    <Panel title="Edit shared context" eyebrow="Direct canonical correction">
      <p>
        Saving writes a new canonical context version, invalidates dependent units, and schedules
        their redraft. It does not wait for a review or approval step.
      </p>
      <form aria-label="Edit shared context" onSubmit={(event) => void submit(event)}>
        <p>
          <label htmlFor="wiki-edit-title">Entry title</label>
          <input
            id="wiki-edit-title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-edit-body">Canonical content</label>
          <textarea
            id="wiki-edit-body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={8}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-edit-reason">Why this context needs correction</label>
          <textarea
            id="wiki-edit-reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            required
          />
        </p>
        <p>
          <label htmlFor="wiki-edit-affected-units">Affected units (one per line)</label>
          <textarea
            id="wiki-edit-affected-units"
            name="affectedUnits"
            value={affectedUnits}
            onChange={(event) => setAffectedUnits(event.target.value)}
            rows={3}
          />
        </p>
        <button type="submit" disabled={!canSave}>
          {outcome.state === "saving" ? "Saving canonical version…" : "Save canonical wiki edit"}
        </button>
      </form>
      {outcome.state === "error" && <p role="alert">{outcome.message}</p>}
    </Panel>
  );
}

function WikiEditSuccessNotice({ success }: { success: WikiEditSuccess | null }): ReactNode {
  if (success === null) {
    return null;
  }
  return (
    <Panel
      title="Canonical wiki version saved"
      eyebrow="Node-8 context correction"
      data-wiki-edit-success="true"
    >
      <p>
        Version <code>{success.versionId}</code> is now the canonical head.
      </p>
      <p>
        Invalidated {success.invalidatedArtifactIds.length} dependent context artifact(s); the
        redraft job is <code>{success.jobId}</code>.
      </p>
      <p>
        {success.affectedUnitIds.length} affected unit(s) will resolve the new head in their next
        ContextPacket.
      </p>
    </Panel>
  );
}

/** Project the typed node-8 correction result into the persistent success notice. */
function editSuccessFromResponse(value: ApiWikiEditResponse): {
  versionId: string;
  invalidatedArtifactIds: string[];
  affectedUnitIds: string[];
  jobId: string;
} {
  return {
    versionId: value.contextEntryVersionId,
    invalidatedArtifactIds: value.invalidatedArtifactIds,
    affectedUnitIds: value.affectedUnitIds,
    jobId: value.redraftJobId,
  };
}

function initialSelection(
  model: WikiContextEntriesReadModel,
  focusEntryId: string | null,
  focusKind: WikiEntryRouteParams["focusKind"],
): string {
  if (focusEntryId !== null) {
    return resolveFocusEntryId(model.entries, focusEntryId, focusKind) ?? "";
  }
  return model.entries[0]?.contextArtifactId ?? "";
}

/**
 * Addressable character URLs predate the generic context-artifact IDs. A
 * character's durable semantic id is retained in its canonical data payload,
 * so resolve it without attempting to construct a browser-side hash. Terms
 * may opt in with `termId` or `surfaceForm`; otherwise an old term URL stays
 * explicitly unresolved instead of opening a misleading unrelated entry.
 */
function resolveFocusEntryId(
  entries: readonly WikiContextEntry[],
  focusEntryId: string,
  focusKind: WikiEntryRouteParams["focusKind"],
): string | null {
  const direct = entries.find((entry) => entry.contextArtifactId === focusEntryId);
  if (direct !== undefined) {
    return direct.contextArtifactId;
  }
  const legacy = parseLegacyFocusEntryId(focusEntryId, focusKind);
  if (legacy === null) {
    return null;
  }
  const entry = entries.find((candidate) => {
    if (candidate.kind !== legacy.kind) {
      return false;
    }
    if (legacy.kind === "character") {
      return stringData(candidate, "characterId") === legacy.id;
    }
    return (
      stringData(candidate, "termId") === legacy.id ||
      stringData(candidate, "surfaceForm") === legacy.id
    );
  });
  return entry?.contextArtifactId ?? null;
}

function parseLegacyFocusEntryId(
  focusEntryId: string,
  focusKind: WikiEntryRouteParams["focusKind"],
): { kind: "character" | "term"; id: string } | null {
  if (focusKind === null) {
    return null;
  }
  const prefix = `${focusKind}:`;
  if (!focusEntryId.startsWith(prefix)) {
    return null;
  }
  const id = focusEntryId.slice(prefix.length);
  return id.length > 0 ? { kind: focusKind, id } : null;
}

function stringData(entry: WikiContextEntry, key: string): string | null {
  const value = entry.data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function formatDate(value: Date | string | null): string {
  if (value === null) {
    return "—";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
