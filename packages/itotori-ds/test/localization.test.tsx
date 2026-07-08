import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BiText } from "../src/components/localization/BiText.js";

describe("localization / BiText", () => {
  it("renders source-first with both locale tokens", () => {
    render(
      <BiText
        sourceLocale="ja-JP"
        targetLocale="en-US"
        source="また明日。"
        translation="See you tomorrow."
      />,
    );
    expect(screen.getByText("ja-JP")).toBeInTheDocument();
    expect(screen.getByText("en-US")).toBeInTheDocument();
    expect(screen.getByText("また明日。")).toBeInTheDocument();
    expect(screen.getByText("See you tomorrow.")).toBeInTheDocument();
  });

  it("copies the translation via the injected handler and confirms", async () => {
    const onCopy = vi.fn();
    render(<BiText source="源" translation="See you tomorrow." onCopy={onCopy} />);
    await userEvent.click(screen.getByRole("button", { name: "copy" }));
    expect(onCopy).toHaveBeenCalledWith("See you tomorrow.");
    expect(await screen.findByRole("button", { name: "copied" })).toBeInTheDocument();
  });
});
