// wiki-entry-ui (HI-FI STUDIO EPIC · Wiki) — the Wiki entry surface.
//
// A WIKI surface: the user browses character + term profiles, navigating by
// entry title (NavPills), and reads each entry's profile (character bio /
// relationships / appearances, or term translation / aliases / references)
// with CrossRef jumps to the scenes where the entry is cited. Backed by the
// EXISTING wiki.entries read-model (wiki-readmodel-api) — consumed THROUGH
// the typed ItotoriApiClient (`useApiQuery`, never an ad-hoc fetch) and
// painted with @itotori/ds (NavPills / Panel / Badge / DataTable / BiText),
// tokens-never-literals.
//
// The read-model's entries carry:
//   - character: bio text + appearances (cited units) + relationships (to
//     other characters, each with its own citations) + related cross-refs +
//     revisions.
//   - term: preferred translation + aliases + references (cited units) +
//     related cross-refs.
// The cited units (appearances / references / relationship citations) each
// carry a `bridgeUnitId` — the addressable UNIT the wiki entry is witnessed
// in. Those become the "jump to scene" source links: a deep-link to
// /play/units/:bridgeUnitId lands the Play scene picker on that unit (and
// its parent scene). `related` cross-refs (character / term / scene /
// source_unit) deep-link to their own addressable surface.
//
// Rendered INSIDE the shell frame (the shell-frame-ui gate): `App` dispatches
// bare `/wiki` here, and fnd-addressable-routing deep-links
// (`/wiki/characters/:id`, `/wiki/terms/:id`) focus an entry.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered profiles + cross-ref jumps + loading / empty / error states
// are asserted.

import { useState, type ReactNode } from "react";
import {
  Badge,
  BiText,
  DataTable,
  NavPills,
  Panel,
  WikiEntry as DsWikiEntry,
  type NavPillItem,
} from "@itotori/ds";
import type {
  WikiCitation,
  WikiCrossReference,
  WikiEntriesReadModel,
  WikiEntry as WikiEntryReadModel,
  WikiEntryKind,
  WikiCharacterEntry,
  WikiTermEntry,
} from "@itotori/db";
import type { ApiWikiEntriesResponse } from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import { hrefForAddressable } from "../addressable-routing.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

const wikiEntryKindValues = {
  character: "character",
  term: "term",
} as const satisfies Record<string, WikiEntryKind>;

// ---------------------------------------------------------------------------
// Route identity — `/wiki` (bare) plus addressable deep-links
// (`/wiki/characters|terms/:id` via `wikiRouteFromAddressable`). Optional
// `?projectId=&localeBranchId=` scopes the wiki; omitted, the screen falls
// back to the project's selected locale branch (same source the play-scene
// picker and the dashboard reviewer panel use). Focus fields come from
// fnd-addressable-routing deep-links so a character/term URL selects +
// stamps `data-addressable-focus`.
// ---------------------------------------------------------------------------

export const wikiRoutePathRegex = /^\/wiki\/?$/u;

/** The wiki page size — a generous first page so the index is useful. */
const WIKI_ENTRY_INDEX_LIMIT = 100;

export type WikiEntryRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
  /** Focused entry kind (from /wiki/characters|terms/:id). */
  focusKind: WikiEntryKind | null;
  /** Focused entry id (`character:<id>` / `term:<id>`). */
  focusEntryId: string | null;
};

export function parseWikiRoute(pathname: string, search: string): WikiEntryRouteParams | null {
  if (!wikiRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  return {
    projectId: nonEmpty(params.get("projectId")),
    localeBranchId: nonEmpty(params.get("localeBranchId")),
    focusKind: null,
    focusEntryId: null,
  };
}

/**
 * Map an addressable wiki deep-link (character / term) onto the Wiki entry
 * route params. Used by `App` when `parseAddressableLocation` resolves a
 * wiki-surface target.
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

/** Build a wiki entry id (`character:<id>` / `term:<id>`) from a kind + raw id. */
export function entryIdFor(kind: WikiEntryKind, id: string): string {
  return `${kind}:${id}`;
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Screen — dispatches on whether a branch scope was supplied explicitly.
// ---------------------------------------------------------------------------

export function WikiEntryScreen({ route }: { route: WikiEntryRouteParams }): ReactNode {
  if (route.projectId !== null && route.localeBranchId !== null) {
    return (
      <WikiEntryForBranch
        projectId={route.projectId}
        localeBranchId={route.localeBranchId}
        focus={wikiFocusFromRoute(route)}
      />
    );
  }
  return <WikiEntryFromStatus focus={wikiFocusFromRoute(route)} />;
}

type WikiFocus = {
  kind: WikiEntryKind | null;
  entryId: string | null;
};

function wikiFocusFromRoute(route: WikiEntryRouteParams): WikiFocus {
  return { kind: route.focusKind, entryId: route.focusEntryId };
}

/**
 * No explicit `?projectId=&localeBranchId=` — scope the wiki to the project's
 * selected locale branch, read through the typed client.
 */
function WikiEntryFromStatus({ focus }: { focus: WikiFocus }): ReactNode {
  const status = useApiQuery("projects.status", {}, "wiki-entry:status");
  if (status.state === "loading") {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="loading">
        <ShellHeader eyebrow="Wiki" title="Wiki entries" />
        <LoadingState label="Loading project context…" />
      </main>
    );
  }
  if (status.state === "error") {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="error">
        <ShellHeader eyebrow="Wiki" title="Wiki entries" />
        <ErrorState title="Wiki entries" error={status.error} />
      </main>
    );
  }
  const projectId = status.state === "ready" ? status.data.projectId : null;
  const localeBranchId = status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (projectId === null || localeBranchId === null) {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="empty">
        <ShellHeader eyebrow="Wiki" title="Wiki entries" />
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to browse wiki entries."
        />
      </main>
    );
  }
  return <WikiEntryForBranch projectId={projectId} localeBranchId={localeBranchId} focus={focus} />;
}

function WikiEntryForBranch({
  projectId,
  localeBranchId,
  focus,
}: {
  projectId: string;
  localeBranchId: string;
  focus: WikiFocus;
}): ReactNode {
  const entries = useApiQuery(
    "wiki.entries",
    { query: { projectId, localeBranchId, limit: WIKI_ENTRY_INDEX_LIMIT } },
    `wiki-entry:entries:${projectId}:${localeBranchId}`,
  );
  const focusToken = focus.entryId;
  return (
    <main
      className="itotori-shell wiki-entry"
      data-screen="wiki-entry"
      data-state={entries.state}
      data-locale-branch-id={localeBranchId}
      data-addressable-focus={focusToken ?? undefined}
      data-addressable-focused={focusToken !== null ? "true" : undefined}
      data-focus-kind={focus.kind ?? undefined}
    >
      <ShellHeader eyebrow="Wiki" title="Wiki entries" />
      {entries.state === "loading" && <LoadingState label="Loading wiki entries…" />}
      {entries.state === "empty" && (
        <EmptyState
          title="Wiki entries"
          message="No character or term entries were returned for this locale branch."
        />
      )}
      {entries.state === "error" && <ErrorState title="Wiki entries" error={entries.error} />}
      {entries.state === "ready" && <WikiEntryReady model={entries.data} focus={focus} />}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Ready — the entry index (NavPills labeled by title) + the selected entry's
// profile (character bio / relationships / appearances, or term translation /
// aliases / references) with CrossRef jumps to scenes.
// ---------------------------------------------------------------------------

function WikiEntryReady({
  model,
  focus,
}: {
  model: ApiWikiEntriesResponse;
  focus: WikiFocus;
}): ReactNode {
  const initial = initialWikiSelection(model, focus);
  const [selectedEntryId, setSelectedEntryId] = useState<string>(initial);
  const selectedEntry =
    model.entries.find((entry) => entry.entryId === selectedEntryId) ?? model.entries[0] ?? null;

  const items: NavPillItem[] = model.entries.map((entry) => ({
    id: entry.entryId,
    label: entry.title,
    badge: entryKindBadge(entry),
  }));

  const scope = branchScope(model);

  return (
    <section
      className="wiki-entry__body"
      aria-label="Wiki entries"
      data-selected-entry-id={selectedEntry?.entryId ?? ""}
      data-selected-kind={selectedEntry?.kind ?? ""}
      data-entry-count={model.entries.length}
    >
      <NavPills
        items={items}
        activeId={selectedEntry?.entryId ?? ""}
        onSelect={setSelectedEntryId}
        label="Wiki entries by title"
        className="wiki-entry__index"
      />
      {selectedEntry === null ? (
        <EmptyState title="No entry selected" message="This locale branch has no wiki entries." />
      ) : (
        <WikiEntryProfile entry={selectedEntry} scope={scope} focus={focus} />
      )}
    </section>
  );
}

function WikiEntryProfile({
  entry,
  scope,
  focus,
}: {
  entry: WikiEntryReadModel;
  scope: AddressableScope;
  focus: WikiFocus;
}): ReactNode {
  const focusToken = focus.entryId;
  if (entry.kind === wikiEntryKindValues.character) {
    return <CharacterProfile entry={entry} scope={scope} focusToken={focusToken} />;
  }
  return <TermProfile entry={entry} scope={scope} focusToken={focusToken} />;
}

// ---------------------------------------------------------------------------
// CharacterProfile — bio + appearances (jump to scene) + relationships (jump
// to character / scene) + related cross-refs + revisions.
// ---------------------------------------------------------------------------

function CharacterProfile({
  entry,
  scope,
  focusToken,
}: {
  entry: WikiCharacterEntry;
  scope: AddressableScope;
  focusToken: string | null;
}): ReactNode {
  return (
    <DsWikiEntry
      title={entry.title}
      kind="character"
      locale={entry.bio.locale}
      identifier={entry.characterId}
      status={entry.bio.status}
      stale={entry.bio.stale}
      className="wiki-entry__profile"
      data-wiki-kind="character"
      data-character-id={entry.characterId}
      data-addressable-focus={focusToken ?? undefined}
      data-addressable-focused={focusToken !== null ? "true" : undefined}
      facts={[
        { label: "Character", value: entry.characterId, mono: true },
        { label: "Appearances", value: entry.appearances.length },
        { label: "Relationships", value: entry.relationships.length },
      ]}
    >
      <p className="wiki-entry__bio" data-wiki-bio={entry.characterId}>
        {entry.bio.text}
      </p>

      <section
        className="wiki-entry__appearances"
        data-wiki-appearance-count={entry.appearances.length}
      >
        <h3 className="wiki-entry__subhead">Appearances</h3>
        <CitationTable
          caption="Cited units"
          emptyLabel="No appearances were cited for this character."
          citations={entry.appearances}
          scope={scope}
        />
      </section>

      <section
        className="wiki-entry__relationships"
        data-wiki-relationship-count={entry.relationships.length}
      >
        <h3 className="wiki-entry__subhead">Relationships</h3>
        {entry.relationships.length === 0 ? (
          <p className="wiki-entry__empty">No relationships were recorded for this character.</p>
        ) : (
          <ul className="wiki-entry__relationship-list">
            {entry.relationships.map((relationship) => (
              <li
                key={relationship.characterRelationshipId}
                className="wiki-entry__relationship"
                data-relationship-id={relationship.characterRelationshipId}
              >
                <div className="wiki-entry__relationship-head">
                  <a
                    href={hrefForAddressable({
                      kind: "character",
                      id: relationship.toCharacterId,
                      ...scope,
                    })}
                    className="wiki-entry__crossref"
                    data-wiki-cross-ref="character"
                    data-wiki-cross-ref-id={relationship.toCharacterId}
                  >
                    {relationship.toCharacterId}
                  </a>
                  <Badge status={relationship.status}>{relationship.kind}</Badge>
                  <span className="wiki-entry__relationship-descriptor">
                    {relationship.descriptor}
                  </span>
                </div>
                {relationship.citations.length > 0 && (
                  <CitationTable
                    caption="Relationship witnesses"
                    emptyLabel="No witnesses were cited for this relationship."
                    citations={relationship.citations}
                    scope={scope}
                    compact
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CrossReferenceList related={entry.related} scope={scope} />

      {entry.revisions.length > 0 && (
        <section
          className="wiki-entry__revisions"
          data-wiki-revision-count={entry.revisions.length}
        >
          <h3 className="wiki-entry__subhead">Revisions</h3>
          <DataTable
            caption="Bio revisions"
            columns={[
              {
                key: "revision",
                header: "Revision",
                render: (row) => <code>{row.characterBioId}</code>,
              },
              {
                key: "status",
                header: "Status",
                render: (row) => <Badge status={row.status}>{row.status}</Badge>,
              },
              {
                key: "generated",
                header: "Generated",
                render: (row) => formatDate(row.generatedAt),
              },
            ]}
            rows={entry.revisions}
            getRowKey={(row) => row.characterBioId}
            emptyLabel="No revisions were recorded."
          />
        </section>
      )}
    </DsWikiEntry>
  );
}

// ---------------------------------------------------------------------------
// TermProfile — preferred translation + aliases + references (jump to scene)
// + related cross-refs.
// ---------------------------------------------------------------------------

function TermProfile({
  entry,
  scope,
  focusToken,
}: {
  entry: WikiTermEntry;
  scope: AddressableScope;
  focusToken: string | null;
}): ReactNode {
  return (
    <DsWikiEntry
      title={entry.title}
      kind="term"
      locale={entry.termKind}
      identifier={entry.termId}
      status={entry.status}
      className="wiki-entry__profile"
      data-wiki-kind="term"
      data-term-id={entry.termId}
      data-addressable-focus={focusToken ?? undefined}
      data-addressable-focused={focusToken !== null ? "true" : undefined}
      facts={[
        { label: "Term", value: entry.termId, mono: true },
        { label: "Aliases", value: entry.aliases.length },
        { label: "References", value: entry.references.length },
      ]}
    >
      <BiText
        sourceLocale={entry.sourceLocale}
        targetLocale={entry.targetLocale}
        source={entry.sourceTerm}
        translation={entry.preferredTranslation}
        speaker={entry.partOfSpeech ?? entry.termKind}
      />
      {entry.notes !== null && <p className="wiki-entry__notes">{entry.notes}</p>}

      <section className="wiki-entry__aliases" data-wiki-alias-count={entry.aliases.length}>
        <h3 className="wiki-entry__subhead">Aliases</h3>
        <DataTable
          caption="Term aliases"
          columns={[
            { key: "alias", header: "Alias", render: (row) => row.aliasText },
            { key: "kind", header: "Kind", render: (row) => row.aliasKind },
            {
              key: "locale",
              header: "Locale",
              render: (row) => row.locale ?? "—",
            },
          ]}
          rows={entry.aliases}
          getRowKey={(row) => row.aliasId}
          emptyLabel="No aliases were recorded for this term."
        />
      </section>

      <section
        className="wiki-entry__references"
        data-wiki-reference-count={entry.references.length}
      >
        <h3 className="wiki-entry__subhead">References</h3>
        <DataTable
          caption="Cited units"
          columns={[
            {
              key: "unit",
              header: "Unit",
              render: (row) => <SceneJump citation={row} scope={scope} />,
            },
            { key: "kind", header: "Kind", render: (row) => row.referenceKind },
            {
              key: "citation",
              header: "Citation",
              render: (row) => row.citation,
            },
            {
              key: "context",
              header: "Context",
              render: (row) => row.context ?? "—",
            },
          ]}
          rows={entry.references}
          getRowKey={(row) => row.sourceRefId}
          emptyLabel="No references were cited for this term."
        />
      </section>

      <CrossReferenceList related={entry.related} scope={scope} />
    </DsWikiEntry>
  );
}

// ---------------------------------------------------------------------------
// Cross references — the `related[]` array on every entry. Each ref deep-
// links to its own addressable surface (character / term / scene / unit).
// ---------------------------------------------------------------------------

function CrossReferenceList({
  related,
  scope,
}: {
  related: WikiCrossReference[];
  scope: AddressableScope;
}): ReactNode {
  return (
    <section className="wiki-entry__crossrefs" data-wiki-crossref-count={related.length}>
      <h3 className="wiki-entry__subhead">Cross references</h3>
      <DataTable
        caption="Cross references"
        columns={[
          {
            key: "label",
            header: "Entry",
            render: (row) => <CrossRefLink crossRef={row} scope={scope} />,
          },
          { key: "kind", header: "Kind", render: (row) => row.refKind },
          {
            key: "relation",
            header: "Relation",
            render: (row) => row.relation,
          },
        ]}
        rows={related}
        getRowKey={(row) => `${row.refKind}:${row.refId}:${row.relation}`}
        emptyLabel="No cross references were recorded."
      />
    </section>
  );
}

function CrossRefLink({
  crossRef,
  scope,
}: {
  crossRef: WikiCrossReference;
  scope: AddressableScope;
}): ReactNode {
  const href = crossRefHref(crossRef, scope);
  if (href === null) {
    return <span>{crossRef.label}</span>;
  }
  return (
    <a
      href={href}
      className="wiki-entry__crossref"
      data-wiki-cross-ref={crossRef.refKind}
      data-wiki-cross-ref-id={crossRef.refId}
    >
      {crossRef.label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Citation table — the shared "jump to scene" rendering for cited units
// (character appearances + relationship witnesses). Each cited unit's
// `bridgeUnitId` deep-links to /play/units/:id so the Play scene picker
// focuses the unit (and its parent scene).
// ---------------------------------------------------------------------------

function CitationTable({
  caption,
  emptyLabel,
  citations,
  scope,
  compact = false,
}: {
  caption: string;
  emptyLabel: string;
  citations: WikiCitation[];
  scope: AddressableScope;
  compact?: boolean;
}): ReactNode {
  return (
    <DataTable
      caption={caption}
      columns={
        compact
          ? [
              {
                key: "unit",
                header: "Unit",
                render: (row) => <SceneJump citation={row} scope={scope} />,
              },
            ]
          : [
              {
                key: "unit",
                header: "Unit",
                render: (row) => <SceneJump citation={row} scope={scope} />,
              },
              {
                key: "ordinal",
                header: "Cite #",
                align: "end",
                render: (row) => row.citeOrdinal,
              },
            ]
      }
      rows={citations}
      getRowKey={(row) => `${row.bridgeUnitId}:${row.citeOrdinal}`}
      emptyLabel={emptyLabel}
    />
  );
}

/** A cited-unit deep-link — jumps to /play/units/:bridgeUnitId. */
function SceneJump({
  citation,
  scope,
}: {
  citation: { bridgeUnitId: string | null; sourceUnitKey: string | null };
  scope: AddressableScope;
}): ReactNode {
  const label = citation.sourceUnitKey ?? citation.bridgeUnitId ?? "—";
  if (citation.bridgeUnitId === null) {
    return <span>{label}</span>;
  }
  const href = hrefForAddressable({ kind: "unit", id: citation.bridgeUnitId, ...scope });
  return (
    <a href={href} className="wiki-entry__scene-jump" data-wiki-scene-jump={citation.bridgeUnitId}>
      {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AddressableScope = { projectId: string | null; localeBranchId: string | null };

function branchScope(model: WikiEntriesReadModel): AddressableScope {
  return { projectId: model.filter.projectId, localeBranchId: model.filter.localeBranchId };
}

/** Resolve the initial entry selection from an addressable focus. */
function initialWikiSelection(model: ApiWikiEntriesResponse, focus: WikiFocus): string {
  if (focus.entryId !== null) {
    const focused = model.entries.find((entry) => entry.entryId === focus.entryId);
    if (focused !== undefined) {
      return focused.entryId;
    }
  }
  if (focus.kind !== null) {
    const byKind = model.entries.find((entry) => entry.kind === focus.kind);
    if (byKind !== undefined) {
      return byKind.entryId;
    }
  }
  return model.entries[0]?.entryId ?? "";
}

/** A short kind badge for the entry index (the title distinguishes entries). */
function entryKindBadge(entry: WikiEntryReadModel): ReactNode {
  return entry.kind === wikiEntryKindValues.character ? "char" : "term";
}

/** Map a cross reference onto its addressable href (null when unresolvable). */
function crossRefHref(crossRef: WikiCrossReference, scope: AddressableScope): string | null {
  switch (crossRef.refKind) {
    case "character":
      return hrefForAddressable({ kind: "character", id: crossRef.refId, ...scope });
    case "term":
      return hrefForAddressable({ kind: "term", id: crossRef.refId, ...scope });
    case "scene":
      return hrefForAddressable({ kind: "scene", id: crossRef.refId, ...scope });
    case "source_unit":
      return hrefForAddressable({ kind: "unit", id: crossRef.refId, ...scope });
    default:
      return null;
  }
}

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}
