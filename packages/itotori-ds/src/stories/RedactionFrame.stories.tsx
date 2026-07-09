import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { RedactionFrame } from "../components/data/RedactionFrame.js";

function DemoFrame(): ReactNode {
  return (
    <div
      style={{
        width: 240,
        height: 120,
        background: "linear-gradient(135deg, #3a4a6a, #1a2030)",
        display: "grid",
        placeItems: "center",
        color: "#c8d0e0",
        fontFamily: "var(--ito-font-mono, monospace)",
        fontSize: 12,
      }}
    >
      frame preview
    </div>
  );
}

const meta = {
  title: "data/RedactionFrame",
  component: RedactionFrame,
  args: {
    sensitive: true,
    canReveal: false,
    shareRedaction: false,
    children: <DemoFrame />,
  },
} satisfies Meta<typeof RedactionFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Sensitive + no reveal → redacted by default. */
export const Redacted: Story = {
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector("[data-redacted]");
    await expect(root).toHaveAttribute("data-redacted", "true");
    await expect(within(canvasElement).getByText(/sensitive/i)).toBeInTheDocument();
  },
};

/** Cap-gated reveal unblurs when not in share mode. */
export const Revealed: Story = {
  args: {
    sensitive: true,
    canReveal: true,
    shareRedaction: false,
  },
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector("[data-redacted]");
    await expect(root).toHaveAttribute("data-redacted", "false");
  },
};

/** Share/export mode always forces redaction even with canReveal. */
export const ShareForced: Story = {
  args: {
    sensitive: true,
    canReveal: true,
    shareRedaction: true,
    label: "share mode — always redacted",
  },
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector("[data-redacted]");
    await expect(root).toHaveAttribute("data-redacted", "true");
    await expect(root).toHaveAttribute("data-share-redaction", "true");
  },
};

export const NotSensitive: Story = {
  args: {
    sensitive: false,
  },
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector("[data-redacted]");
    await expect(root).toHaveAttribute("data-redacted", "false");
  },
};
