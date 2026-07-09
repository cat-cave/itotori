import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Badge } from "../components/core/Badge.js";
import { galleryStatuses } from "./fixtures.js";

const meta = {
  title: "core/Badge",
  component: Badge,
  args: {
    status: "running",
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default auto-tone from a known product status. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const badge = canvas.getByText("running");
    await expect(badge).toBeInTheDocument();
    await expect(badge).toHaveAttribute("data-status", "running");
  },
};

/** Closed status vocabulary — every status paints its derived tone. */
export const StatusVocabulary: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
      {galleryStatuses.map((status) => (
        <Badge key={status} status={status} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const status of galleryStatuses) {
      await expect(canvas.getByText(status)).toBeInTheDocument();
    }
  },
};

/** Explicit tone override (rare). */
export const ToneOverride: Story = {
  args: {
    status: "queued",
    tone: "critical",
    children: "force-critical",
  },
};
