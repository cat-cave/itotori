import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WikiEntry } from "../src/components/wiki/WikiEntry.js";

describe("wiki / WikiEntry", () => {
  it("renders profile chrome, facts, status, and projected data attributes", () => {
    render(
      <WikiEntry
        title="Glossary term"
        kind="term"
        locale="system_term"
        identifier="term:magic"
        status="active"
        data-addressable-focus="term:magic"
        facts={[
          { label: "Aliases", value: 2 },
          { label: "Term", value: "term:magic", mono: true },
        ]}
      >
        <p>Preferred translation details.</p>
      </WikiEntry>,
    );

    const entry = document.querySelector(".itotori-wiki-entry");
    expect(entry).toHaveAttribute("data-wiki-kind", "term");
    expect(entry).toHaveAttribute("data-addressable-focus", "term:magic");
    expect(screen.getAllByText("term:magic")).toHaveLength(2);
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Preferred translation details.")).toBeInTheDocument();
  });

  it("renders cross references as links when hrefs are provided", () => {
    render(
      <WikiEntry
        title="Character"
        kind="character"
        crossRefs={[{ id: "scene:1", label: "scene.001", href: "/play/scenes/scene.001" }]}
      />,
    );
    expect(screen.getByRole("link", { name: "scene.001" })).toHaveAttribute(
      "href",
      "/play/scenes/scene.001",
    );
  });

  it("marks stale entries with the stale badge vocabulary", () => {
    render(<WikiEntry title="Character" kind="character" status="Fresh" stale />);
    expect(screen.getByText("stale")).toBeInTheDocument();
  });
});
