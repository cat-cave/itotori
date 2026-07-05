// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_BUNDLE_KIND,
  DEMO_BUNDLE_SCHEMA_VERSION,
  type DemoBundle,
  isManagedRuntimeUri,
  renderDemoBundle,
} from "../src/demo-bundle.js";

// The single committed source of truth for the demo bundle: the byte-golden the
// Rust `utsushi_fixture::mvmz_demo_bundle` builder produces. The playback
// surface renders it DATA-ONLY — the same bytes the Rust integration test
// byte-compares. vitest runs from the package directory, so the repo-relative
// path climbs two levels.
function loadBundle(): DemoBundle {
  const bundlePath = resolve(
    process.cwd(),
    "../../crates/utsushi-fixture/tests/fixtures/mvmz_demo_bundle/bundle.golden.json",
  );
  return JSON.parse(readFileSync(bundlePath, "utf8")) as DemoBundle;
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MV/MZ embedded playback demo bundle surface", () => {
  it("renders the committed bundle kind + schema version this surface expects", () => {
    const bundle = loadBundle();
    expect(bundle.schemaVersion).toBe(DEMO_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundleKind).toBe(DEMO_BUNDLE_KIND);
  });

  it("opens a public patched MV/MZ fixture playback surface — not a live game", () => {
    const bundle = loadBundle();
    renderDemoBundle(root, bundle);

    const main = root.querySelector('[data-route="demo-bundle"]');
    expect(main?.getAttribute("data-bundle-source")).toBe("fixture");
    // The surface is explicitly NOT a live game.
    expect(main?.getAttribute("data-live")).toBe("false");
    const notice = root.querySelector("[data-demo-fixture-notice]");
    expect(notice?.textContent ?? "").toContain("NOT a live game");
    expect(root.querySelector('[data-surface-live="false"]')).not.toBeNull();
    expect(root.querySelector('[data-live-badge="false"]')).not.toBeNull();

    // The playback surface descriptor names the patched fixture, not a runtime.
    expect(root.textContent).toContain("patched_mvmz_fixture");
    expect(root.textContent).toContain("fixture:mvmz-patched-fixture");
  });

  it("links every observed text/choice to a bridge unit ref", () => {
    const bundle = loadBundle();
    renderDemoBundle(root, bundle);

    const events = [...root.querySelectorAll<HTMLElement>('[data-section="observation"] > li')];
    expect(events.length).toBe(bundle.observationEnvelope.events.length);

    // Each observed dialogue line renders its translated text + bridge ref.
    const textEvents = [...root.querySelectorAll<HTMLElement>('[data-event-kind="text"]')];
    expect(textEvents.length).toBe(2);
    expect(root.textContent).toContain("The lighthouse keeps watch over the quiet cove.");
    for (const li of textEvents) {
      expect(li.getAttribute("data-bridge-unit-id")).toMatch(/^019ed000-/);
      expect(li.querySelector("[data-bridge-ref]")).not.toBeNull();
    }

    // The choice renders its prompt + each option's bridge ref.
    const choice = root.querySelector('[data-event-kind="choice"]');
    expect(choice).not.toBeNull();
    expect(choice?.textContent ?? "").toContain("What will you do?");
    const options = [...root.querySelectorAll<HTMLElement>('[data-section="choice-options"] > li')];
    expect(options.length).toBe(2);
    for (const option of options) {
      expect(option.getAttribute("data-bridge-unit-id")).toMatch(/^019ed000-/);
    }

    // No observed event is left unlinked.
    expect(root.querySelector('[data-state="unlinked"]')).toBeNull();
  });

  it("renders validated capture references as managed URIs, never painted pixels", () => {
    const bundle = loadBundle();
    renderDemoBundle(root, bundle);

    const captures = [...root.querySelectorAll<HTMLElement>('[data-section="captures"] > li')];
    expect(captures.length).toBe(bundle.captureRefs.refs.length);
    expect(captures.length).toBe(3);

    // Every capture is validated + surfaced only as a managed runtime URI.
    for (const capture of captures) {
      expect(capture.querySelector('[data-capture-validated="true"]')).not.toBeNull();
      const code = capture.querySelector("code");
      expect(code?.textContent ?? "").toMatch(/^artifacts\/utsushi\/runtime\//);
      expect(capture.querySelector('[data-state="blocked-uri"]')).toBeNull();
      // A capture links to its bridge unit ref + trace event.
      expect(capture.querySelector("[data-bridge-ref]")).not.toBeNull();
    }

    // The playback surface NEVER paints game pixels.
    expect(root.querySelector("img, video, audio, canvas")).toBeNull();
  });

  it("references the UTSUSHI-119/102/065/010 proof + review artifacts", () => {
    const bundle = loadBundle();
    renderDemoBundle(root, bundle);

    // Patched proof (119) + alpha proof (102) render as proven proof links.
    const patched = root.querySelector('[data-proof-link="patched-runtime-proof"]');
    expect(patched?.getAttribute("data-proof-source")).toBe("UTSUSHI-119");
    expect(patched?.querySelector('[data-proof-proven="true"]')).not.toBeNull();
    expect(patched?.textContent ?? "").toContain(
      bundle.proofLinks.patchedRuntimeProof.proofId ?? "",
    );

    const alpha = root.querySelector('[data-proof-link="alpha-proof"]');
    expect(alpha?.getAttribute("data-proof-source")).toBe("UTSUSHI-102");
    expect(alpha?.querySelector('[data-proof-proven="true"]')).not.toBeNull();

    // Screenshot evidence (065) is referenced.
    expect(root.querySelector('[data-proof-link="screenshot-evidence"]')).not.toBeNull();
    expect(root.textContent).toContain("UTSUSHI-065");

    // Review manifest (010) surfaces its id + supported actions.
    expect(root.textContent).toContain("UTSUSHI-010");
    expect(root.textContent).toContain(bundle.reviewManifest.reviewPackageId ?? "");
    expect(root.querySelector('[data-review-action="approve"]')).not.toBeNull();
    expect(root.querySelector('[data-review-action="import_runtime_feedback"]')).not.toBeNull();
  });

  it("renders the bundle validation verdict and per-check status", () => {
    const bundle = loadBundle();
    renderDemoBundle(root, bundle);

    expect(root.querySelector('[data-bundle-valid="true"]')).not.toBeNull();
    const checks = [...root.querySelectorAll<HTMLElement>('[data-section="validation"] > li')];
    expect(checks.length).toBe(bundle.validation.checks.length);
    // Every committed check passed, so no failing rows render.
    for (const check of checks) {
      expect(check.getAttribute("data-check-status")).toBe("pass");
    }
    expect(root.querySelector('[data-check-id="capture_refs_validated"]')).not.toBeNull();
    expect(root.querySelector('[data-check-id="observation_events_bridge_linked"]')).not.toBeNull();
  });

  it("is a pure, synchronous render — no fetch, no live runtime host", () => {
    const bundle = loadBundle();
    const result = renderDemoBundle(root, bundle);
    // renderDemoBundle returns void synchronously (not a Promise).
    expect(result).toBeUndefined();
    expect(root.querySelector('[data-route="demo-bundle"]')).not.toBeNull();
  });

  it("blocks a non-managed capture URI instead of surfacing it", () => {
    const bundle = loadBundle();
    // Tamper a capture URI into a non-managed (host-path) shape.
    bundle.captureRefs.refs[0]!.artifactRef.uri = "file:///home/trevor/leak.png";
    bundle.captureRefs.refs[0]!.validated = false;
    renderDemoBundle(root, bundle);

    expect(root.querySelector('[data-state="blocked-uri"]')).not.toBeNull();
    expect(root.querySelector('[data-capture-validated="false"]')).not.toBeNull();
    // The tampered URI itself is never surfaced verbatim.
    expect(document.body.innerHTML).not.toContain("file:///home/trevor/leak.png");
  });

  it("refuses to render a bundle with an unknown schema version or kind", () => {
    const bundle = loadBundle();
    bundle.schemaVersion = "0.0.0";
    renderDemoBundle(root, bundle);
    const banner = root.querySelector<HTMLElement>('[data-error="bundle-mismatch"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent ?? "").toContain("utsushi.demo_bundle.mismatch");
  });

  it("never renders a host-path-shaped substring anywhere in the DOM", () => {
    const bundle = loadBundle();
    renderDemoBundle(root, bundle);
    const html = document.body.innerHTML;
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
    expect(/[A-Z]:[\\/]/.test(html)).toBe(false);
  });

  it("agrees with the Rust managed-uri guard on representative URIs", () => {
    expect(isManagedRuntimeUri("artifacts/utsushi/runtime/x/y.png")).toBe(true);
    expect(isManagedRuntimeUri("/abs/artifacts/utsushi/runtime/x.png")).toBe(false);
    expect(isManagedRuntimeUri("file://artifacts/utsushi/runtime/x.png")).toBe(false);
    expect(isManagedRuntimeUri("artifacts/utsushi/runtime/../etc/passwd")).toBe(false);
    expect(isManagedRuntimeUri("data:image/png;base64,AA")).toBe(false);
  });
});
