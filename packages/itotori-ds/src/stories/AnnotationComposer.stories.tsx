import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AnnotationComposer } from "../components/game/AnnotationComposer.js";

const meta = {
  title: "game/AnnotationComposer",
  component: AnnotationComposer,
  args: {
    onSubmit: fn(),
    contextLabel: "scene · line context",
  },
} satisfies Meta<typeof AnnotationComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const form = canvasElement.querySelector("[data-component='annotation-composer']");
    await expect(form).not.toBeNull();
    await expect(form).toHaveAttribute("data-severity", "warning");
    const note = canvas.getByPlaceholderText(/What's wrong/i);
    await userEvent.type(note, "Tone feels off on this line.");
    await userEvent.click(canvas.getByRole("button", { name: /Send to review/i }));
    await expect(args.onSubmit).toHaveBeenCalled();
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    disabledReason: "missing feedback.import",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByRole("button", { name: /Send to review/i });
    await expect(submit).toBeDisabled();
  },
};
