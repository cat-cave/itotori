// @vitest-environment jsdom
//
// Behaviour proof for the play-tester Wiki surface. The real App shell reads
// generic, run-generated node-6 context through the typed wiki API, exposes
// provenance/citations/history/impact, and submits a direct node-8 correction
// without an approval queue.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  WikiContextEntriesReadModel,
  WikiContextEntry,
  WikiContextEntryDetail,
  WikiContextEntryHistoryReadModel,
  WikiContextEntryKind,
  WikiContextEntryVersion,
} from "@itotori/db";
import type { ApiWikiEditResponse, ApiWikiShowResponse } from "../src/api-schema.js";
import { App } from "../src/ui/App.js";
import { hrefForAddressable } from "../src/ui/addressable-routing.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const PROJECT_ID = "project-1";
const LOCALE_BRANCH_ID = "019ed065-0000-7000-8000-000000000110";
const SOURCE_REVISION_ID = "revision-run-44";
const GENERATED_AT = new Date("2026-07-11T14:30:00.000Z");
const SELECTED_ENTRY_ID = "context-scene-opening";

const WIKI_ROUTE = {
  pathname: "/wiki",
  search: `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
};

const categoryForKind: Record<WikiContextEntryKind, WikiContextEntry["category"]> = {
  scene: "scene_summary",
  character: "character_note",
  route: "route_map",
  term: "terminology_candidate",
  speaker: "speaker_label",
  glossary: "glossary",
  style: "style",
  note: "context_note",
};

const titleForKind: Record<WikiContextEntryKind, string> = {
  scene: "Opening scene memory",
  character: "Captain Aya",
  route: "Moonlit route",
  term: "Aether term",
  speaker: "Aya speaker voice",
  glossary: "Astral glossary",
  style: "Narrative style",
  note: "Play-tester note",
};

let currentBody = "Run-generated opening scene enrichment with the shrine bell and Captain Aya.";
let currentTitle = titleForKind.scene;
let capturedEdit: unknown = null;
let capturedAdd: unknown = null;
let addedEntry: WikiContextEntry | null = null;

function genericEntry(kind: WikiContextEntryKind, ordinal: number): WikiContextEntry {
  const selected = kind === "scene";
  const contextArtifactId = selected ? SELECTED_ENTRY_ID : `context-${kind}-${ordinal}`;
  return {
    contextArtifactId,
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    category: categoryForKind[kind],
    kind,
    status: "active",
    title: selected ? currentTitle : titleForKind[kind],
    body: selected ? currentBody : `Run-generated ${kind} enrichment for the shared brain.`,
    data: {
      kind,
      runStage: "enrich",
      confidence: "grounded",
      ...(kind === "character"
        ? { semanticKind: "character_bio", characterId: "captain-aya" }
        : {}),
    },
    contentHash: `hash-${kind}-${ordinal}`,
    headVersionId:
      selected && currentBody.startsWith("Corrected") ? "version-scene-3" : "version-scene-2",
    versionCount: selected && currentBody.startsWith("Corrected") ? 3 : 2,
    provenance: {
      producedByAgent: "semantic-enricher",
      producedByTool: "tool.context-enrich",
      producerVersion: "6.0.0",
      createdByUserId: null,
      origin: "run_generated",
      runId: "run-enrich-44",
      providerRunId: "provider-run-44",
      provenance: { runId: "run-enrich-44", model: "context-model", stage: "enrich" },
    },
    citations: [
      {
        bridgeUnitId: `bridge-unit-${kind}-${ordinal}`,
        sourceRevisionId: SOURCE_REVISION_ID,
        sourceHash: `source-hash-${kind}-${ordinal}`,
        citation: `scene.${String(ordinal).padStart(3, "0")}.line.001`,
        metadata: { evidence: "run source witness" },
      },
    ],
    impact: {
      affectedUnitIds: [`bridge-unit-${kind}-${ordinal}`],
      invalidatedReason: selected ? "context correction superseded prior scene facts" : null,
      invalidatedAt: selected ? GENERATED_AT : null,
    },
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
  };
}

function entryVersion(
  entry: WikiContextEntry,
  input: { id: string; body: string; parentVersionId: string | null; isHead: boolean },
): WikiContextEntryVersion {
  return {
    contextEntryVersionId: input.id,
    contextArtifactId: entry.contextArtifactId,
    parentVersionId: input.parentVersionId,
    projectId: entry.projectId,
    localeBranchId: entry.localeBranchId,
    sourceRevisionId: entry.sourceRevisionId,
    category: entry.category,
    kind: entry.kind,
    status: entry.status,
    title: entry.title,
    body: input.body,
    data: entry.data,
    contentHash: `history-${input.id}`,
    provenance: entry.provenance,
    citations: entry.citations,
    impact: entry.impact,
    createdAt: GENERATED_AT,
    isHead: input.isHead,
  };
}

function selectedDetail(): WikiContextEntryDetail {
  const entry = genericEntry("scene", 1);
  const versions = [
    entryVersion(entry, {
      id: "version-scene-1",
      body: "Initial run-generated shrine context.",
      parentVersionId: null,
      isHead: false,
    }),
    entryVersion(entry, {
      id: "version-scene-2",
      body: "Run-generated opening scene enrichment with the shrine bell and Captain Aya.",
      parentVersionId: "version-scene-1",
      isHead: currentBody.startsWith("Corrected") === false,
    }),
  ];
  if (currentBody.startsWith("Corrected")) {
    versions.push(
      entryVersion(entry, {
        id: "version-scene-3",
        body: currentBody,
        parentVersionId: "version-scene-2",
        isHead: true,
      }),
    );
  }
  return { ...entry, history: versions };
}

function characterDetail(): WikiContextEntryDetail {
  const entry = genericEntry("character", 2);
  return {
    ...entry,
    history: [
      entryVersion(entry, {
        id: "version-character-1",
        body: entry.body,
        parentVersionId: null,
        isHead: true,
      }),
    ],
  };
}

function addedDetail(): WikiContextEntryDetail {
  const entry: WikiContextEntry = {
    ...genericEntry("note", 99),
    contextArtifactId: "context-note-shrine-timing",
    title: "Shrine bell timing",
    body: "The bell tolls before Aya enters the shrine.",
    headVersionId: "version-note-1",
    versionCount: 1,
    provenance: {
      producedByAgent: "play-tester",
      producedByTool: "tool.play-tester-context-correction",
      producerVersion: "1.0.0",
      createdByUserId: "local-user",
      origin: "play_tester_edit",
      runId: null,
      providerRunId: null,
      provenance: { origin: "play_tester_edit", reason: "Observed during play testing" },
    },
    citations: [
      {
        bridgeUnitId: "bridge-unit-added-by-tester",
        sourceRevisionId: SOURCE_REVISION_ID,
        sourceHash: "source-hash-added",
        citation: "scene.099.line.001",
        metadata: { evidence: "play tester observation" },
      },
    ],
    impact: {
      affectedUnitIds: ["bridge-unit-added-by-tester"],
      invalidatedReason: null,
      invalidatedAt: null,
    },
  };
  return {
    ...entry,
    history: [
      entryVersion(entry, {
        id: "version-note-1",
        body: entry.body,
        parentVersionId: null,
        isHead: true,
      }),
    ],
  };
}

function addedEntryFixture(): WikiContextEntry {
  const { history: _history, ...entry } = addedDetail();
  return entry;
}

function entriesFixture(): WikiContextEntriesReadModel {
  const entries = [
    ...(Object.keys(titleForKind) as WikiContextEntryKind[]).map((kind, index) =>
      genericEntry(kind, index + 1),
    ),
    ...(addedEntry === null ? [] : [addedEntry]),
  ];
  return {
    schemaVersion: "wiki.context.entries.v0.1",
    generatedAt: GENERATED_AT,
    filter: {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: null,
      kind: null,
      includeStale: true,
    },
    pagination: { total: entries.length, limit: 100, offset: 0, hasMore: false, nextOffset: null },
    entries,
  };
}

function showFixture(): ApiWikiShowResponse {
  return {
    schemaVersion: "wiki.context.entry.v0.1",
    generatedAt: GENERATED_AT,
    entry: selectedDetail(),
  };
}

function historyFixture(): WikiContextEntryHistoryReadModel {
  const detail = selectedDetail();
  return {
    schemaVersion: "wiki.context.entry-history.v0.1",
    generatedAt: GENERATED_AT,
    contextArtifactId: detail.contextArtifactId,
    headVersionId: detail.headVersionId,
    versions: detail.history,
  };
}

function editFixture(): ApiWikiEditResponse {
  return {
    schemaVersion: "wiki.context.edit.v0.2",
    generatedAt: GENERATED_AT,
    correctionId: "context-correction-wiki-screen",
    contextArtifactId: SELECTED_ENTRY_ID,
    contextEntryVersionId: "version-scene-3",
    affectedUnitIds: ["bridge-unit-scene-1", "bridge-unit-added-by-tester"],
    invalidatedArtifactIds: ["context-route-3", "context-speaker-4"],
    redraftJobId: "job-context-redraft-77",
    rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
    entry: selectedDetail(),
  };
}

function addFixture(): ApiWikiEditResponse {
  const entry = addedDetail();
  return {
    schemaVersion: "wiki.context.edit.v0.2",
    generatedAt: GENERATED_AT,
    correctionId: "context-correction-wiki-add",
    contextArtifactId: entry.contextArtifactId,
    contextEntryVersionId: "version-note-1",
    affectedUnitIds: ["bridge-unit-added-by-tester"],
    invalidatedArtifactIds: [],
    redraftJobId: "job-context-redraft-add-88",
    rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
    entry,
  };
}

const wikiListPath = `*/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/wiki`;
const wikiEntryPath = `${wikiListPath}/${SELECTED_ENTRY_ID}`;

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get(`${wikiEntryPath}/history`, () => apiJson("wiki.history", historyFixture())),
  http.post(wikiListPath, async ({ request }) => {
    capturedAdd = await request.json();
    addedEntry = addedEntryFixture();
    return apiJson("wiki.add", addFixture());
  }),
  http.post(wikiEntryPath, async ({ request }) => {
    capturedEdit = await request.json();
    currentTitle = "Captain Aya of the Shrine";
    currentBody =
      "Corrected opening scene context resolves Aya's shrine title for the next packet.";
    return apiJson("wiki.edit", editFixture());
  }),
  http.get(wikiEntryPath, () => apiJson("wiki.show", showFixture())),
  http.get(wikiListPath, () => apiJson("wiki.list", entriesFixture())),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  currentBody = "Run-generated opening scene enrichment with the shrine bell and Captain Aya.";
  currentTitle = titleForKind.scene;
  capturedEdit = null;
  capturedAdd = null;
  addedEntry = null;
});
afterAll(() => server.close());

describe("SPA shell — generic context Wiki", () => {
  it("browses every generic run-generated context kind with content, provenance, citations, impact, and immutable history", async () => {
    render(<App location={WIKI_ROUTE} />);

    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "wiki-entry");
    expect(main).toHaveAttribute("data-state", "ready");
    expect(main).toHaveAttribute("data-locale-branch-id", LOCALE_BRANCH_ID);

    const index = screen.getByRole("navigation", { name: "Context entries by title" });
    for (const title of Object.values(titleForKind)) {
      expect(within(index).getByRole("tab", { name: new RegExp(title, "u") })).toBeInTheDocument();
    }

    expect(screen.getByRole("heading", { name: "Content" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Provenance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Citations" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Impact" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByText("semantic-enricher")).toBeInTheDocument();
    expect(screen.getByText("run-enrich-44")).toBeInTheDocument();
    expect(screen.getByText("Initial run-generated shrine context.")).toBeInTheDocument();
    expect(screen.getAllByText("version-scene-2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("context correction superseded prior scene facts")).toBeInTheDocument();
    expect(screen.getByText("bridge-unit-scene-1", { selector: "a" })).toHaveAttribute(
      "data-wiki-scene-jump",
      "bridge-unit-scene-1",
    );
  });

  it("pages through the complete canonical context index instead of stopping at the first 100 entries", async () => {
    const pageTwoDetail = characterDetail();
    const { history: _pageTwoHistory, ...pageTwoEntry } = pageTwoDetail;
    server.use(
      http.get(wikiListPath, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset");
        const model = entriesFixture();
        if (offset === "100") {
          return apiJson("wiki.list", {
            ...model,
            entries: [pageTwoEntry],
            pagination: { total: 101, limit: 100, offset: 100, hasMore: false, nextOffset: null },
          });
        }
        return apiJson("wiki.list", {
          ...model,
          entries: [genericEntry("scene", 1)],
          pagination: { total: 101, limit: 100, offset: 0, hasMore: true, nextOffset: 100 },
        });
      }),
      http.get(`${wikiListPath}/${pageTwoDetail.contextArtifactId}/history`, () =>
        apiJson("wiki.history", {
          schemaVersion: "wiki.context.entry-history.v0.1",
          generatedAt: GENERATED_AT,
          contextArtifactId: pageTwoDetail.contextArtifactId,
          headVersionId: pageTwoDetail.headVersionId,
          versions: pageTwoDetail.history,
        }),
      ),
      http.get(`${wikiListPath}/${pageTwoDetail.contextArtifactId}`, () =>
        apiJson("wiki.show", {
          schemaVersion: "wiki.context.entry.v0.1",
          generatedAt: GENERATED_AT,
          entry: pageTwoDetail,
        }),
      ),
    );

    render(<App location={WIKI_ROUTE} />);
    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();

    const pager = screen.getByRole("navigation", { name: "Context wiki pagination" });
    expect(pager).toHaveTextContent("Page 1 of 2 · 101 context items");
    expect(within(pager).getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(within(pager).getByRole("button", { name: "Next page" }));

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Selected context entry" })).toHaveAttribute(
        "data-context-artifact-id",
        pageTwoDetail.contextArtifactId,
      );
    });
    expect(screen.getByRole("tab", { name: /Captain Aya/u })).toBeInTheDocument();
    const pageTwoPager = screen.getByRole("navigation", { name: "Context wiki pagination" });
    expect(pageTwoPager).toHaveTextContent("Page 2 of 2 · 101 context items");
    expect(within(pageTwoPager).getByRole("button", { name: "Next page" })).toBeDisabled();

    fireEvent.click(within(pageTwoPager).getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();
  });

  it("submits a direct wiki correction, reports version/invalidation/job success, and refreshes the canonical entry", async () => {
    render(<App location={WIKI_ROUTE} />);
    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();

    const editor = screen.getByRole("form", { name: "Edit shared context" });
    fireEvent.change(within(editor).getByLabelText("Entry title"), {
      target: { value: "Captain Aya of the Shrine" },
    });
    fireEvent.change(within(editor).getByLabelText("Canonical content"), {
      target: {
        value: "Corrected opening scene context resolves Aya's shrine title for the next packet.",
      },
    });
    fireEvent.change(within(editor).getByLabelText("Why this context needs correction"), {
      target: { value: "The play test established Aya's canonical shrine title." },
    });
    fireEvent.change(within(editor).getByLabelText("Affected units (one per line)"), {
      target: { value: "bridge-unit-scene-1\nbridge-unit-added-by-tester" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save canonical wiki edit" }));

    await waitFor(() => {
      expect(capturedEdit).toEqual({
        title: "Captain Aya of the Shrine",
        body: "Corrected opening scene context resolves Aya's shrine title for the next packet.",
        reason: "The play test established Aya's canonical shrine title.",
        affectedUnitIds: ["bridge-unit-scene-1", "bridge-unit-added-by-tester"],
      });
    });
    expect(
      await screen.findByRole("heading", {
        name: "Canonical wiki version saved; redraft completed",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("version-scene-3").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("job-context-redraft-77")).toBeInTheDocument();
    expect(screen.getByText(/Invalidated 2 dependent context artifact/)).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Corrected opening scene context resolves Aya's shrine title for the next packet.",
        { selector: "p" },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|reject|defer/i })).not.toBeInTheDocument();
  });

  it("keeps the canonical-save receipt honest when the redraft is retrying", async () => {
    server.use(
      http.post(wikiEntryPath, () =>
        apiJson("wiki.edit", {
          ...editFixture(),
          rerun: {
            state: "pending",
            jobStatus: "retry_waiting",
            error: "recorded redraft failure; retry is scheduled",
          },
        }),
      ),
    );
    render(<App location={WIKI_ROUTE} />);
    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();

    const editor = screen.getByRole("form", { name: "Edit shared context" });
    fireEvent.change(within(editor).getByLabelText("Why this context needs correction"), {
      target: { value: "Retry the redraft after the provider recovers." },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save canonical wiki edit" }));

    expect(
      await screen.findByRole("heading", { name: "Canonical wiki version saved; redraft pending" }),
    ).toBeInTheDocument();
    const receipt = screen.getByTestId("wiki-edit-receipt");
    expect(receipt).toHaveAttribute("data-wiki-rerun-state", "pending");
    expect(receipt).toHaveTextContent("The redraft is retry_waiting");
    expect(receipt).toHaveTextContent("recorded redraft failure; retry is scheduled");
    expect(
      screen.queryByRole("heading", { name: "Canonical wiki version saved; redraft completed" }),
    ).not.toBeInTheDocument();
  });

  it("adds new shared context through the same canonical correction surface", async () => {
    render(<App location={WIKI_ROUTE} />);
    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();

    const addForm = screen.getByRole("form", { name: "Add shared context" });
    expect(within(addForm).getByLabelText("Source revision")).toHaveValue(SOURCE_REVISION_ID);
    fireEvent.change(within(addForm).getByLabelText("Entry title"), {
      target: { value: "Shrine bell timing" },
    });
    fireEvent.change(within(addForm).getByLabelText("Canonical content"), {
      target: { value: "The bell tolls before Aya enters the shrine." },
    });
    fireEvent.change(within(addForm).getByLabelText("Why this context matters"), {
      target: { value: "Observed during play testing" },
    });
    fireEvent.change(within(addForm).getByLabelText("Affected units (one per line)"), {
      target: { value: "bridge-unit-added-by-tester" },
    });
    fireEvent.click(within(addForm).getByRole("button", { name: "Add canonical context" }));

    await waitFor(() => {
      expect(capturedAdd).toEqual({
        sourceRevisionId: SOURCE_REVISION_ID,
        kind: "note",
        title: "Shrine bell timing",
        body: "The bell tolls before Aya enters the shrine.",
        reason: "Observed during play testing",
        affectedUnitIds: ["bridge-unit-added-by-tester"],
      });
    });
    expect(
      await screen.findByRole("heading", {
        name: "Canonical wiki version saved; redraft completed",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("job-context-redraft-add-88")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /Shrine bell timing/u })).toBeInTheDocument();
  });

  it("keeps loading, empty, and typed error states visible", async () => {
    server.use(http.get(wikiListPath, () => new Promise(() => {})));
    const { unmount } = render(<App location={WIKI_ROUTE} />);
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "loading");
    expect(screen.getByText("Loading context entries…")).toBeInTheDocument();
    unmount();

    server.use(
      http.get(wikiListPath, () =>
        apiJson("wiki.list", {
          ...entriesFixture(),
          entries: [],
          pagination: { total: 0, limit: 100, offset: 0, hasMore: false, nextOffset: null },
        }),
      ),
    );
    render(<App location={WIKI_ROUTE} />);
    expect(
      await screen.findByText(
        "No run-generated or play-tester context entries were returned for this locale branch.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "empty");
    cleanup();

    server.use(
      http.get(wikiListPath, () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read shared context" },
          { status: 403 },
        ),
      ),
    );
    render(<App location={WIKI_ROUTE} />);
    expect(await screen.findByText("not permitted to read shared context")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "error");
  });

  it("falls back to the selected project branch and keeps Wiki navigation active", async () => {
    render(<App location={{ pathname: "/wiki", search: "" }} />);
    expect(await screen.findByText(currentBody, { selector: "p" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Surfaces" });
    expect(within(nav).getByRole("tab", { name: "Wiki" })).toHaveAttribute("aria-selected", "true");
  });

  it("resolves a legacy character link through canonical semantic data instead of opening an unrelated entry", async () => {
    const href = hrefForAddressable({
      kind: "character",
      id: "captain-aya",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const separator = href.indexOf("?");
    const detail = characterDetail();
    server.use(
      http.get(`${wikiListPath}/context-character-2/history`, () =>
        apiJson("wiki.history", {
          schemaVersion: "wiki.context.entry-history.v0.1",
          generatedAt: GENERATED_AT,
          contextArtifactId: detail.contextArtifactId,
          headVersionId: detail.headVersionId,
          versions: detail.history,
        }),
      ),
      http.get(`${wikiListPath}/context-character-2`, () =>
        apiJson("wiki.show", {
          schemaVersion: "wiki.context.entry.v0.1",
          generatedAt: GENERATED_AT,
          entry: detail,
        }),
      ),
    );
    render(
      <App
        location={{
          pathname: separator === -1 ? href : href.slice(0, separator),
          search: separator === -1 ? "" : href.slice(separator),
        }}
      />,
    );

    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-addressable-focus", "character:captain-aya");
    expect(main).toHaveAttribute("data-focus-kind", "character");
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Selected context entry" })).toHaveAttribute(
        "data-context-artifact-id",
        "context-character-2",
      );
    });
  });
});
