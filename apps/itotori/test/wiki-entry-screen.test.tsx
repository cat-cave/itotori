// @vitest-environment jsdom
// wiki-entry-ui (HI-FI STUDIO EPIC · Wiki) — behavior-first test for the
// Wiki entry screen.
//
// Mounts the REAL `App` shell over msw-intercepted `/api/wiki/entries` (+ the
// shell-frame status reads) and asserts the OBSERVABLE behavior the viewer
// sees, per the acceptance:
//
//   1. the wiki lists entries by their TITLE (a NavPills pill per entry);
//   2. a CHARACTER entry renders its bio + appearances, with CrossRef jumps
//      to the scenes (units) where it is cited + a cross-ref to a related
//      character;
//   3. a TERM entry renders its source ↔ preferred-translation BiText +
//      references, with CrossRef jumps to the cited scenes + a cross-ref to
//      a related character;
//   4. character / term addressable deep-links FOCUS the entry;
//   5. loading / empty / error are handled (never a blank panel).
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered profiles + cross-ref jumps + states are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { WikiCharacterEntry, WikiEntriesReadModel, WikiTermEntry } from "@itotori/db";
import { App } from "../src/ui/App.js";
import { hrefForAddressable } from "../src/ui/addressable-routing.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const PROJECT_ID = "project-1";
const LOCALE_BRANCH_ID = "019ed065-0000-7000-8000-000000000110";
const SOURCE_REVISION_ID = "revision-wiki";
const GENERATED_AT = new Date("2026-07-06T00:00:00.000Z");

// A CHARACTER entry with one cited appearance (a unit the heroine is
// witnessed in) + one relationship (to a second character, witnessed in a
// second unit) + a related-character cross-ref + one revision.
function heroineEntry(): WikiCharacterEntry {
  return {
    entryId: "character:勇者",
    kind: "character",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    title: "勇者",
    characterId: "勇者",
    bio: {
      characterBioId: "bio-hero",
      locale: "ja-JP",
      text: "村を守る主人公。",
      status: "Fresh",
      stale: false,
      generatedAt: GENERATED_AT,
    },
    appearances: [
      {
        bridgeUnitId: "bridge-unit-wiki-one",
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: null,
        citedSourceHash: "hash-one",
        citeOrdinal: 1,
      },
    ],
    related: [{ refKind: "character", refId: "王女", label: "王女", relation: "Friendship" }],
    relationships: [
      {
        characterRelationshipId: "rel-hero-princess",
        toCharacterId: "王女",
        kind: "Friendship",
        direction: "Symmetric",
        descriptor: "幼なじみ",
        descriptorLocale: "ja-JP",
        status: "Fresh",
        generatedAt: GENERATED_AT,
        citations: [
          {
            bridgeUnitId: "bridge-unit-wiki-two",
            sourceUnitKey: "scene.002.line.001",
            occurrenceId: null,
            citedSourceHash: "hash-two",
            citeOrdinal: 1,
          },
        ],
      },
    ],
    revisions: [
      {
        characterBioId: "bio-hero",
        sourceRevisionId: SOURCE_REVISION_ID,
        status: "Fresh",
        generatedAt: GENERATED_AT,
      },
    ],
  };
}

// A TERM entry (distinct title from the character so the index pills are
// unambiguous) with one alias + one reference (a cited unit) + a related-
// character cross-ref (terminology_alias).
function magicTermEntry(): WikiTermEntry {
  return {
    entryId: "term:term-magic",
    kind: "term",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    title: "魔法",
    termId: "term-magic",
    sourceTerm: "魔法",
    preferredTranslation: "Magic",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    termKind: "system_term",
    partOfSpeech: "noun",
    status: "active",
    notes: null,
    aliases: [
      { aliasId: "alias-magic", aliasText: "Sorcery", aliasKind: "target_alias", locale: "en-US" },
    ],
    references: [
      {
        sourceRefId: "ref-magic",
        sourceRevisionId: SOURCE_REVISION_ID,
        bridgeUnitId: "bridge-unit-wiki-one",
        sourceUnitKey: "scene.001.line.001",
        referenceKind: "source_unit",
        citation: "scene.001.line.001",
        context: "opening incantation",
      },
    ],
    related: [
      { refKind: "character", refId: "勇者", label: "勇者", relation: "terminology_alias" },
    ],
  };
}

function wikiEntriesFixture(overrides: Partial<WikiEntriesReadModel> = {}): WikiEntriesReadModel {
  return {
    schemaVersion: "wiki.entries.v0.1",
    generatedAt: GENERATED_AT,
    filter: {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: null,
      kind: null,
    },
    pagination: { total: 2, limit: 100, offset: 0, hasMore: false, nextOffset: null },
    entries: [heroineEntry(), magicTermEntry()],
    ...overrides,
  };
}

const WIKI_ROUTE = {
  pathname: "/wiki",
  search: `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
};

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/wiki/entries", () => apiJson("wiki.entries", wikiEntriesFixture())),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("SPA shell — Wiki entry screen", () => {
  it("lists entries by their title", async () => {
    render(<App location={WIKI_ROUTE} />);

    expect(await screen.findByRole("heading", { name: "Wiki entries" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "wiki-entry");
    expect(main).toHaveAttribute("data-state", "ready");
    expect(main).toHaveAttribute("data-locale-branch-id", LOCALE_BRANCH_ID);

    // ENTRIES: a NavPills pill per entry, labeled by the title — one character
    // (勇者) + one term (魔法). The accessible name includes the kind badge
    // (e.g. "勇者char"), so match on the title substring.
    const nav = screen.getByRole("navigation", { name: "Wiki entries by title" });
    expect(within(nav).getByRole("tab", { name: /勇者/ })).toBeInTheDocument();
    expect(within(nav).getByRole("tab", { name: /魔法/ })).toBeInTheDocument();
  });

  it("renders the character profile (bio + appearances) and CrossRef jumps to scenes", async () => {
    render(<App location={WIKI_ROUTE} />);

    // The first entry (character) is auto-selected. Its bio renders verbatim.
    expect(await screen.findByText("村を守る主人公。")).toBeInTheDocument();

    const bio = screen.getByText("村を守る主人公。");
    const profile = bio.closest("section");
    expect(profile).toHaveAttribute("data-wiki-kind", "character");
    expect(profile).toHaveAttribute("data-character-id", "勇者");

    // Appearances: the cited unit is a jump-to-scene link → /play/units/:id.
    const sceneJump = screen.getByText("scene.001.line.001", { selector: "a" });
    expect(sceneJump).toHaveAttribute("data-wiki-scene-jump", "bridge-unit-wiki-one");
    expect(sceneJump.getAttribute("href")).toContain("/play/units/bridge-unit-wiki-one");

    // Relationship + related → cross-refs to the related character (王女),
    // each a deep-link to /wiki/characters/:id.
    const characterRefs = screen.getAllByText("王女");
    expect(characterRefs.length).toBeGreaterThanOrEqual(1);
    for (const ref of characterRefs) {
      expect(ref.tagName).toBe("A");
      expect(ref).toHaveAttribute("data-wiki-cross-ref", "character");
      expect(ref.getAttribute("href")).toContain("/wiki/characters/");
    }
  });

  it("renders the term profile (source ↔ translation) and CrossRef jumps to scenes", async () => {
    render(<App location={WIKI_ROUTE} />);

    // Switch to the term entry (魔法).
    const nav = await screen.findByRole("navigation", { name: "Wiki entries by title" });
    fireEvent.click(within(nav).getByRole("tab", { name: /魔法/ }));

    // The term's preferred translation renders verbatim.
    expect(await screen.findByText("Magic")).toBeInTheDocument();

    const profile = screen.getByText("Magic").closest("section");
    expect(profile).toHaveAttribute("data-wiki-kind", "term");
    expect(profile).toHaveAttribute("data-term-id", "term-magic");

    // References: the cited unit is a jump-to-scene link → /play/units/:id
    // (scoped to the term profile + anchor selector so it is unambiguous —
    // the citation column repeats the source-unit key as plain text).
    const sceneJump = within(profile).getByText("scene.001.line.001", { selector: "a" });
    expect(sceneJump).toHaveAttribute("data-wiki-scene-jump", "bridge-unit-wiki-one");

    // Related → cross-ref to the character (勇者) → /wiki/characters/:id.
    const characterRef = within(profile).getByText("勇者");
    expect(characterRef.tagName).toBe("A");
    expect(characterRef).toHaveAttribute("data-wiki-cross-ref", "character");
    expect(characterRef.getAttribute("href")).toContain("/wiki/characters/");
  });

  it("focuses a character deep-link and stamps the addressable focus token", async () => {
    const href = hrefForAddressable({
      kind: "character",
      id: "勇者",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const { pathname, search } = splitHref(href);
    render(<App location={{ pathname, search }} />);

    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-screen", "wiki-entry");
    expect(main).toHaveAttribute("data-addressable-focus", "character:勇者");
    expect(main).toHaveAttribute("data-addressable-focused", "true");
    expect(main).toHaveAttribute("data-focus-kind", "character");

    // The focused character's profile renders + its focus token is stamped.
    expect(await screen.findByText("村を守る主人公。")).toBeInTheDocument();
    const profile = screen.getByText("村を守る主人公。").closest("section");
    expect(profile).toHaveAttribute("data-addressable-focus", "character:勇者");
  });

  it("focuses a term deep-link and stamps the addressable focus token", async () => {
    const href = hrefForAddressable({
      kind: "term",
      id: "term-magic",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const { pathname, search } = splitHref(href);
    render(<App location={{ pathname, search }} />);

    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-screen", "wiki-entry");
    expect(main).toHaveAttribute("data-addressable-focus", "term:term-magic");
    expect(main).toHaveAttribute("data-focus-kind", "term");

    // The focused term's preferred translation renders.
    expect(await screen.findByText("Magic")).toBeInTheDocument();
  });

  it("shows loading placeholders while the read is in flight", () => {
    server.use(http.get("*/api/wiki/entries", () => new Promise(() => {})));
    render(<App location={WIKI_ROUTE} />);
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "loading");
    expect(screen.getByText("Loading wiki entries…")).toBeInTheDocument();
  });

  it("surfaces the empty state when no entries are returned", async () => {
    server.use(
      http.get("*/api/wiki/entries", () =>
        apiJson(
          "wiki.entries",
          wikiEntriesFixture({
            entries: [],
            pagination: { total: 0, limit: 100, offset: 0, hasMore: false, nextOffset: null },
          }),
        ),
      ),
    );
    render(<App location={WIKI_ROUTE} />);
    expect(
      await screen.findByText("No character or term entries were returned for this locale branch."),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "empty");
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/wiki/entries", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read wiki entries" },
          { status: 403 },
        ),
      ),
    );
    render(<App location={WIKI_ROUTE} />);
    expect(await screen.findByText("not permitted to read wiki entries")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "error");
  });

  it("falls back to the project's selected locale branch when no scope is supplied", async () => {
    // Bare /wiki with no query → the screen reads projects.status for the
    // branch scope, then queries wiki.entries for that branch.
    render(<App location={{ pathname: "/wiki", search: "" }} />);

    expect(await screen.findByText("村を守る主人公。")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "ready");
  });

  it("marks the Wiki nav pill active on /wiki", async () => {
    render(<App location={WIKI_ROUTE} />);
    const nav = await screen.findByRole("navigation", { name: "Surfaces" });
    expect(within(nav).getByRole("tab", { name: "Wiki" })).toHaveAttribute("aria-selected", "true");
  });
});

function splitHref(href: string): { pathname: string; search: string } {
  const q = href.indexOf("?");
  if (q === -1) {
    return { pathname: href, search: "" };
  }
  return { pathname: href.slice(0, q), search: href.slice(q) };
}
