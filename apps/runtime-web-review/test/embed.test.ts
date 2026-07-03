// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBED_SCHEMA_VERSION, type EmbedState, renderEmbedState } from "../src/embed.js";

function loadGolden(): EmbedState {
  // vitest runs from the package directory; the golden lives at
  // <repo>/crates/utsushi-core/tests/fixtures/embed_state_golden.json.
  // Using process.cwd() rather than import.meta.url avoids the jsdom env
  // rewriting the URL scheme.
  const goldenPath = resolve(
    process.cwd(),
    "../../crates/utsushi-core/tests/fixtures/embed_state_golden.json",
  );
  const raw = readFileSync(goldenPath, "utf8");
  return JSON.parse(raw) as EmbedState;
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Utsushi embed ABI fixture", () => {
  it("renders the capability list in the declared (sorted) order", () => {
    const state = loadGolden();
    renderEmbedState(root, state);
    const items = [...root.querySelectorAll<HTMLLIElement>("[data-capability-id]")];
    expect(items).toHaveLength(state.capabilities.length);
    const renderedIds = items.map((item) => item.getAttribute("data-capability-id"));
    const declaredIds = state.capabilities.map((entry) => entry.capabilityId);
    expect(renderedIds).toEqual(declaredIds);
  });

  it("renders a disabled action button when a capability is unsupported", () => {
    const state = loadGolden();
    // Mutate the snapshot capability into the unsupported posture so the
    // host-side UI gate is exercised.
    state.capabilities = state.capabilities.map((entry) =>
      entry.capabilityId === "snapshot"
        ? {
            capabilityId: "snapshot",
            status: "unsupported",
            limitations: ["fixture has no snapshot store"],
          }
        : entry,
    );
    delete state.currentSnapshot;
    renderEmbedState(root, state);
    const button = root.querySelector<HTMLButtonElement>('button[data-action="snapshot"]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    // The limitation strings MUST render so the user sees a public-safe
    // reason instead of silent failure.
    expect(root.textContent).toContain("fixture has no snapshot store");
    // The typed accessor error must also render in the snapshot section.
    expect(root.textContent).toContain(
      "utsushi.embed.capability_not_supported: capability_id=snapshot",
    );
  });

  it("renders trace lines with engine-neutral text", () => {
    const state = loadGolden();
    renderEmbedState(root, state);
    const traceItems = [...root.querySelectorAll<HTMLLIElement>("[data-line-id]")];
    expect(traceItems).toHaveLength(state.trace.lines.length);
    for (const line of state.trace.lines) {
      const li = root.querySelector<HTMLLIElement>(`[data-line-id="${line.lineId}"]`);
      expect(li).not.toBeNull();
      expect(li?.textContent ?? "").toContain(line.text);
    }
    // The sourceAsset is an AssetId (vfs:// scheme); it is metadata for the
    // text line and the DOM renderer does not paint the asset bytes.
    expect(root.querySelector("img, video, audio")).toBeNull();
  });

  it("renders artifact URIs only under the managed runtime prefix", () => {
    const state = loadGolden();
    renderEmbedState(root, state);
    const codes = [...root.querySelectorAll<HTMLElement>('[data-section="artifact-refs"] code')];
    expect(codes.length).toBeGreaterThanOrEqual(2);
    for (const code of codes) {
      expect(code.textContent ?? "").toMatch(/^artifacts\/utsushi\/runtime\//);
    }
    // No blocked-uri banners on the golden envelope.
    expect(root.querySelector('[data-state="blocked-uri"]')).toBeNull();
  });

  it("labels the rendered envelope as a fixture, not live runtime state", () => {
    const state = loadGolden();
    renderEmbedState(root, state);
    // The embed view renders a canned EmbedState golden; it must not be
    // presented as a live measurement of a running engine port.
    const main = root.querySelector('[data-route="embed-state"]');
    expect(main?.getAttribute("data-embed-source")).toBe("fixture");
    const notice = root.querySelector("[data-embed-fixture-notice]");
    expect(notice).not.toBeNull();
    expect(notice?.textContent ?? "").toContain("NOT live runtime state");
  });

  it("refuses to render an envelope with an unknown schema version", () => {
    const state = loadGolden();
    state.schemaVersion = "0.0.0";
    renderEmbedState(root, state);
    const banner = root.querySelector<HTMLElement>('[data-error="schema-version-mismatch"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent ?? "").toContain("utsushi.embed.schema_version_mismatch");
    expect(banner?.textContent ?? "").toContain(EMBED_SCHEMA_VERSION);
  });

  it("never renders a host-path-shaped substring anywhere in the DOM", () => {
    const state = loadGolden();
    renderEmbedState(root, state);
    const html = document.body.innerHTML;
    // Host-path prefixes the audit-focus item flags.
    const forbiddenPrefixes = [
      "/home/",
      "/tmp/",
      "/var/folders/",
      "/Users/",
      "/root/",
      "file://",
      "data:",
      "blob:",
    ];
    for (const prefix of forbiddenPrefixes) {
      expect(html.includes(prefix), `rendered DOM contained forbidden substring ${prefix}`).toBe(
        false,
      );
    }
    // No drive letter shapes (e.g. "C:\" or "C:/").
    expect(/[A-Z]:[\\/]/.test(html)).toBe(false);
  });
});
