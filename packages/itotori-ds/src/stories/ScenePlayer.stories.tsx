import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AnnotationComposer } from "../components/game/AnnotationComposer.js";
import { ScenePlayer } from "../components/game/ScenePlayer.js";

const capturedFrame = (
  <div
    aria-label="Captured scene frame"
    style={{
      position: "relative",
      display: "grid",
      placeItems: "center",
      width: "100%",
      minHeight: 320,
      overflow: "hidden",
      background:
        "linear-gradient(180deg, rgba(28, 69, 94, 0.9), rgba(12, 19, 28, 0.95) 58%), linear-gradient(90deg, rgba(88, 217, 188, 0.22), rgba(255, 199, 92, 0.14))",
    }}
  >
    <div
      style={{
        position: "absolute",
        insetInline: "12%",
        bottom: "22%",
        height: 2,
        background: "rgba(255, 199, 92, 0.65)",
      }}
    />
    <code
      style={{
        padding: "6px 10px",
        color: "#9ee6d8",
        background: "rgba(6, 10, 16, 0.72)",
        border: "1px solid rgba(158, 230, 216, 0.35)",
      }}
    >
      scene-frame:07:014
    </code>
  </div>
);

const meta = {
  title: "game/ScenePlayer",
  component: ScenePlayer,
  args: {
    unitId: "scene-07-line-014",
    mode: "review",
    status: "captured",
    speaker: "Reviewer",
    sourceLocale: "source",
    targetLocale: "draft",
    sourceText: "The observatory doors unlock at midnight.",
    translationText: "The archive wing opens at midnight.",
    frame: capturedFrame,
    previousLabel: "Previous unit",
    nextLabel: "Next unit",
    onPrevious: fn(),
    onNext: fn(),
  },
} satisfies Meta<typeof ScenePlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const player = canvasElement.querySelector("[data-component='scene-player']");
    await expect(player).not.toBeNull();
    await expect(player).toHaveAttribute("data-mode", "review");
    await expect(canvas.getByText("scene-07-line-014")).toBeInTheDocument();
    await expect(canvas.getByLabelText("Captured scene frame")).toBeInTheDocument();
    await expect(canvas.getByText("The observatory doors unlock at midnight.")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Next unit" }));
    await expect(args.onNext).toHaveBeenCalled();
  },
};

export const WithAnnotation: Story = {
  args: {
    annotation: (
      <AnnotationComposer
        contextLabel="scene-07-line-014"
        defaultSeverity="warning"
        onSubmit={fn()}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("scene-07-line-014")).toHaveLength(2);
    await expect(canvas.getByPlaceholderText(/What's wrong/i)).toBeInTheDocument();
  },
};
