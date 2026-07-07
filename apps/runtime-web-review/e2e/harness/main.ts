// Real-browser e2e harness entry (fe-runtime-web-playwright).
//
// Mounts the SHIPPING runtime-web review modules against the app's OWN
// committed fixtures + built-in seed data so a real Chromium (driven by
// Playwright) can assert observable behavior. No game bytes, no live game, no
// live server: the branch-coverage API is answered in-browser by the app's own
// page builder over its built-in seed fixture (the same seam MSW fronts in the
// jsdom tests), and the embed/demo scenes render committed JSON goldens.

import { renderEmbedState, type EmbedState } from "../../src/embed.js";
import { renderDemoBundle, type DemoBundle } from "../../src/demo-bundle.js";
import { renderBranchExplorer } from "../../src/branch-explorer-view.js";
import {
  BRANCH_EXPLORER_DEFAULT_ENDPOINT,
  buildBranchCoveragePage,
  parseBranchExplorerQuery,
} from "../../src/branch-explorer.js";
import { seedBranchCoverageReadModel } from "../../src/branch-coverage.js";
import { InputSession, bindInteractiveControls, type InputEvent } from "../../src/input-bridge.js";

// The app's OWN committed fixtures (byte-golden JSON produced by the Rust
// fixture builders). These are synthetic MV/MZ demo data, not game bytes.
import embedGolden from "../../../../crates/utsushi-core/tests/fixtures/embed_state_golden.json";
import demoGolden from "../../../../crates/utsushi-fixture/tests/fixtures/mvmz_demo_bundle/bundle.golden.json";

// --- In-browser branch-coverage backend ------------------------------------
// The branch explorer view fetches its 067 page from the runtime API. There is
// no live server, so answer it in the browser from the app's own seed read
// model + page builder — the exact producer the real host route would use.
function installBranchCoverageBackend(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const model = seedBranchCoverageReadModel();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.href);
    if (url.pathname !== BRANCH_EXPLORER_DEFAULT_ENDPOINT) {
      return realFetch(input as RequestInfo, init);
    }
    try {
      const query = parseBranchExplorerQuery(url);
      const page = buildBranchCoveragePage(model, query);
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: { code: "invalid_query", message } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }) as typeof fetch;
}

// --- Input-bridge interactive scene ----------------------------------------
// A minimal engine-neutral scene surface: a background that advances on click
// and two choice options carrying `data-choice-index`. Binds the SHIPPING
// `bindInteractiveControls` so a human's gestures become the engine-neutral
// InputEvent stream, and mirrors the recorded advance/choice events into a
// live DOM readout the e2e can assert.
function mountInputScene(root: HTMLElement): void {
  root.innerHTML = `
    <section aria-label="Runtime input scene" data-route="input-scene">
      <h2>Runtime input</h2>
      <div
        data-testid="scene-surface"
        tabindex="0"
        style="border:1px solid #d1d5db; padding:1rem; min-height:80px"
      >
        <p data-testid="scene-text">The runtime is waiting for input.</p>
        <button type="button" data-choice-index="0" data-testid="choice-0">Left path</button>
        <button type="button" data-choice-index="1" data-testid="choice-1">Right path</button>
      </div>
      <p>Recorded engine-neutral input events:</p>
      <ol data-testid="input-events" style="margin:0"></ol>
      <p>Last committed choice index:
        <span data-testid="last-choice-index">none</span></p>
      <p>Advance count: <span data-testid="advance-count">0</span></p>
    </section>
  `;

  const session = new InputSession({ runId: "e2e-runtime-web" });
  const list = root.querySelector<HTMLOListElement>('[data-testid="input-events"]')!;
  const lastChoice = root.querySelector<HTMLElement>('[data-testid="last-choice-index"]')!;
  const advanceCount = root.querySelector<HTMLElement>('[data-testid="advance-count"]')!;
  let advances = 0;

  const onInput = (event: InputEvent): void => {
    // Mirror only the committed advance/choice gestures (pointer-move noise from
    // the OS cursor is recorded by the bridge but is not asserted behavior).
    if (event.kind !== "advance" && event.kind !== "choice") {
      return;
    }
    const li = document.createElement("li");
    li.setAttribute("data-event-kind", event.kind);
    if (event.kind === "choice") {
      li.setAttribute("data-choice-index", String(event.index));
      li.textContent = `choice ${event.index}`;
      lastChoice.textContent = String(event.index);
    } else {
      advances += 1;
      li.textContent = "advance";
      advanceCount.textContent = String(advances);
    }
    list.append(li);
  };

  const surface = root.querySelector<HTMLElement>('[data-testid="scene-surface"]')!;
  bindInteractiveControls(surface, session, { onInput });
}

// --- Boot ------------------------------------------------------------------
async function boot(): Promise<void> {
  installBranchCoverageBackend();

  renderEmbedState(
    document.querySelector<HTMLElement>("#embed-root")!,
    embedGolden as unknown as EmbedState,
  );
  renderDemoBundle(
    document.querySelector<HTMLElement>("#demo-root")!,
    demoGolden as unknown as DemoBundle,
  );
  mountInputScene(document.querySelector<HTMLElement>("#input-root")!);

  // Optional `?branchPageSize=` drives a small page size so a real
  // forward/back pagination path is exercised over the 4-branch seed model.
  const params = new URLSearchParams(window.location.search);
  const pageSizeParam = params.get("branchPageSize");
  const query =
    pageSizeParam !== null && pageSizeParam !== "" ? { pageSize: Number(pageSizeParam) } : {};
  await renderBranchExplorer(
    document.querySelector<HTMLElement>("#branch-root")!,
    BRANCH_EXPLORER_DEFAULT_ENDPOINT,
    query,
  );

  // Signal readiness for the e2e (all four surfaces mounted).
  document.body.setAttribute("data-harness-ready", "true");
}

void boot();
