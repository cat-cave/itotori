import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ContestantSwatch, type ContestantRole } from "../components/data/ContestantSwatch.js";

const roles: ContestantRole[] = ["official", "self", "self_nocontext", "fan", "mtl"];

const meta = {
  title: "data/ContestantSwatch",
  component: ContestantSwatch,
  args: {
    role: "official" as ContestantRole,
    label: "official",
  },
} satisfies Meta<typeof ContestantSwatch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const swatch = canvas.getByLabelText("official");
    await expect(swatch).toHaveAttribute("data-contestant", "official");
  },
};

/** Full contestant palette — design-review catalog of every role chip. */
export const AllRoles: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
      {roles.map((role) => (
        <span key={role} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <ContestantSwatch role={role} label={role} />
          <code>{role}</code>
        </span>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const role of roles) {
      await expect(canvas.getByLabelText(role)).toBeInTheDocument();
    }
  },
};
