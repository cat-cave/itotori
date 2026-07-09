import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Badge } from "../components/core/Badge.js";
import { Panel } from "../components/layout/Panel.js";

const meta = {
  title: "layout/Panel",
  component: Panel,
  args: {
    title: "Localization progress",
    eyebrow: "overview",
    children: "Panel body — VN config-menu window chrome.",
  },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Localization progress" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("overview")).toBeInTheDocument();
  },
};

export const WithLamps: Story = {
  args: {
    title: "Pass ledger",
    eyebrow: "passes",
    lamps: <Badge status="running" />,
    children: "Trailing lamps slot for status / actions.",
  },
};

export const MintHoverable: Story = {
  args: {
    title: "Model cost / posture",
    eyebrow: "spend",
    tone: "mint",
    hoverable: true,
    children: "Hoverable mint-tone panel.",
  },
};
