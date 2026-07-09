import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WikiEntry } from "../components/wiki/WikiEntry.js";

const meta = {
  title: "wiki/WikiEntry",
  component: WikiEntry,
  args: {
    title: "Archive Curator",
    kind: "character",
    identifier: "wiki:character:archive-curator",
    locale: "en-US",
    status: "in_review",
    facts: [
      { label: "Role", value: "Keeper of the west stacks" },
      { label: "First seen", value: "scene-07-line-014", mono: true },
      { label: "Route", value: "observatory branch" },
    ],
    crossRefs: [
      {
        id: "scene-07",
        label: "scene-07",
        href: "#scene-07",
        kind: "scene",
      },
      {
        id: "term-master-key",
        label: "master-key",
        kind: "term",
      },
    ],
    children: (
      <>
        <p>
          A neutral profile shell for wiki read-model content, including status, facts, body copy,
          and cross-reference chips.
        </p>
        <p>Hosts supply the vocabulary and hrefs; the component only standardizes the chrome.</p>
      </>
    ),
  },
} satisfies Meta<typeof WikiEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Archive Curator" })).toBeInTheDocument();
    await expect(canvas.getByText("character · en-US")).toBeInTheDocument();
    await expect(canvas.getByText("wiki:character:archive-curator")).toBeInTheDocument();
    await expect(canvas.getByText("Keeper of the west stacks")).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "scene-07" })).toHaveAttribute(
      "href",
      "#scene-07",
    );
    await expect(canvas.getByText("master-key")).toBeInTheDocument();
  },
};

export const StaleScene: Story = {
  args: {
    title: "Scene 07",
    kind: "scene",
    identifier: "wiki:scene:07",
    locale: "source",
    status: "captured",
    stale: true,
    facts: [
      { label: "Lines", value: "24" },
      { label: "Review state", value: "needs passback" },
    ],
    crossRefs: [],
    children: <p>Stale entries keep their original status vocabulary while surfacing stale chrome.</p>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Scene 07" })).toBeInTheDocument();
    await expect(canvas.getByText("stale")).toBeInTheDocument();
    await expect(canvas.getByText("needs passback")).toBeInTheDocument();
  },
};
