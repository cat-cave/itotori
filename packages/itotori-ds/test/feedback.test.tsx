import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastViewport } from "../src/components/feedback/Toast.js";
import type { ToastData } from "../src/components/feedback/Toast.js";

const toasts: ToastData[] = [
  { id: "t1", message: "Result revision recorded for the current patch.", tone: "ok" },
  { id: "t2", message: "Context correction scheduled for pass 5.", tone: "neutral" },
];

describe("feedback / Toast", () => {
  it("renders every queued toast in a live region", () => {
    render(<ToastViewport toasts={toasts} onDismiss={() => {}} />);
    expect(screen.getByText("Result revision recorded for the current patch.")).toBeInTheDocument();
    expect(screen.getByText("Context correction scheduled for pass 5.")).toBeInTheDocument();
  });

  it("dismisses a toast by id", async () => {
    const onDismiss = vi.fn();
    render(<ToastViewport toasts={toasts} onDismiss={onDismiss} />);
    const dismissButtons = screen.getAllByRole("button", { name: "Dismiss notification" });
    await userEvent.click(dismissButtons[0] as HTMLElement);
    expect(onDismiss).toHaveBeenCalledWith("t1");
  });
});
