import { describe, expect, it, vi } from "vitest";
import {
  wikiContextEntriesFixture,
  wikiContextEntryFixture,
  wikiContextHistoryFixture,
  wikiEditFixture,
} from "./api-fixtures.js";
import {
  runItotoriCliCommand,
  type ItotoriCliDependencies,
  type ItotoriCliServices,
} from "../src/cli-handlers.js";
import type { WikiBrainServicePort } from "../src/wiki/service.js";

describe("wiki CLI", () => {
  it("routes list, show, and history through the shared wiki service", async () => {
    const { dependencies, wiki, writes } = wikiCliFixture();

    await runItotoriCliCommand(
      [
        "wiki",
        "list",
        "--project",
        "project-1",
        "--locale-branch",
        "locale-1",
        "--source-revision",
        "source-revision-1",
        "--kind",
        "scene",
        "--include-stale",
        "false",
        "--limit",
        "5",
        "--offset",
        "2",
        "--output",
        "wiki-list.json",
      ],
      dependencies,
    );
    await runItotoriCliCommand(
      [
        "wiki",
        "show",
        "--project",
        "project-1",
        "--locale",
        "locale-1",
        "--entry-id",
        "context-artifact-hero-scene",
        "--output",
        "wiki-show.json",
      ],
      dependencies,
    );
    await runItotoriCliCommand(
      [
        "wiki",
        "history",
        "--project",
        "project-1",
        "--locale-branch",
        "locale-1",
        "--entry",
        "context-artifact-hero-scene",
        "--output",
        "wiki-history.json",
      ],
      dependencies,
    );

    expect(wiki.list).toHaveBeenCalledWith({
      projectId: "project-1",
      localeBranchId: "locale-1",
      sourceRevisionId: "source-revision-1",
      kind: "scene",
      includeStale: false,
      limit: 5,
      offset: 2,
    });
    expect(wiki.show).toHaveBeenCalledWith({
      projectId: "project-1",
      localeBranchId: "locale-1",
      contextArtifactId: "context-artifact-hero-scene",
    });
    expect(wiki.history).toHaveBeenCalledWith({
      projectId: "project-1",
      localeBranchId: "locale-1",
      contextArtifactId: "context-artifact-hero-scene",
    });
    expect(writes).toEqual(
      new Map([
        ["wiki-list.json", wikiContextEntriesFixture],
        ["wiki-show.json", wikiContextEntryFixture],
        ["wiki-history.json", wikiContextHistoryFixture],
      ]),
    );
  });

  it("routes existing and new context edits through the same wiki service", async () => {
    const { dependencies, wiki, writes } = wikiCliFixture();

    await runItotoriCliCommand(
      [
        "wiki",
        "edit",
        "--project",
        "project-1",
        "--locale-branch",
        "locale-1",
        "--entry-id",
        "context-artifact-hero-scene",
        "--title",
        "Corrected prologue arrival",
        "--body",
        "The play tester corrected the prologue context.",
        "--reason",
        "The player met the guide after the train arrives.",
        "--affected-unit",
        "bridge-unit-1",
        "--affected-unit",
        "bridge-unit-added-by-tester",
        "--output",
        "wiki-edit.json",
      ],
      dependencies,
    );
    await runItotoriCliCommand(
      [
        "wiki",
        "edit",
        "--project",
        "project-1",
        "--locale",
        "locale-1",
        "--source-revision",
        "source-revision-1",
        "--kind",
        "glossary",
        "--title",
        "Captain Wato",
        "--body",
        "Captain Wato is the canonical title in this route.",
        "--reason",
        "The play test established the title.",
        "--affected-unit",
        "bridge-unit-1",
        "--output",
        "wiki-add.json",
      ],
      dependencies,
    );

    expect(wiki.edit).toHaveBeenCalledWith({
      projectId: "project-1",
      localeBranchId: "locale-1",
      contextArtifactId: "context-artifact-hero-scene",
      title: "Corrected prologue arrival",
      body: "The play tester corrected the prologue context.",
      reason: "The player met the guide after the train arrives.",
      affectedUnitIds: ["bridge-unit-1", "bridge-unit-added-by-tester"],
    });
    expect(wiki.add).toHaveBeenCalledWith({
      projectId: "project-1",
      localeBranchId: "locale-1",
      sourceRevisionId: "source-revision-1",
      kind: "glossary",
      title: "Captain Wato",
      body: "Captain Wato is the canonical title in this route.",
      reason: "The play test established the title.",
      affectedUnitIds: ["bridge-unit-1"],
    });
    expect(writes).toEqual(
      new Map([
        ["wiki-edit.json", wikiEditFixture],
        ["wiki-add.json", wikiEditFixture],
      ]),
    );
  });
});

function wikiCliFixture(): {
  dependencies: ItotoriCliDependencies;
  wiki: WikiBrainServicePort & {
    list: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
    edit: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
  };
  writes: Map<string, unknown>;
} {
  const wiki = {
    list: vi.fn(async () => wikiContextEntriesFixture),
    show: vi.fn(async () => wikiContextEntryFixture),
    history: vi.fn(async () => wikiContextHistoryFixture),
    edit: vi.fn(async () => wikiEditFixture),
    add: vi.fn(async () => wikiEditFixture),
  } satisfies WikiBrainServicePort;
  const writes = new Map<string, unknown>();
  const services = { wiki } as unknown as ItotoriCliServices;
  return {
    dependencies: {
      io: {
        readJson: vi.fn(),
        writeJson: vi.fn((path: string, value: unknown) => {
          writes.set(path, value);
        }),
      },
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    },
    wiki,
    writes,
  };
}
