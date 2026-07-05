// UTSUSHI-134 embedded playback demo bundle renderer.
//
// DATA-ONLY playback surface. Consumes the committed MV/MZ demo-bundle
// descriptor (produced by the Rust `utsushi_fixture::mvmz_demo_bundle` builder,
// which PACKAGES the UTSUSHI-119 patched proof + UTSUSHI-102 alpha proof +
// UTSUSHI-006 patched trace + UTSUSHI-010 review manifest + UTSUSHI-065
// screenshot evidence) and renders the patched fixture's observed text /
// choices, its validated screenshot capture references, the review-manifest
// summary, and the proof links.
//
// It opens a PUBLIC PATCHED MV/MZ FIXTURE playback surface: no live game
// process, no network fetch, no copyrighted bytes. Every field it renders comes
// from the bundle JSON — screenshot artifacts are shown as managed runtime
// artifact URIs (never as painted pixels), so no <img>/<video>/<audio> element
// is ever produced.

export const DEMO_BUNDLE_SCHEMA_VERSION = "0.1.0";
export const DEMO_BUNDLE_KIND = "utsushi.mvmz.embedded_playback_demo_bundle";
export const RUNTIME_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime/";

export type BridgeUnitRef = {
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
};

export type ObservationTextEvent = {
  eventKind: "text";
  bridgeUnitRef: BridgeUnitRef;
  speaker: string | null;
  text: string | null;
  textSurface: string | null;
};

export type ObservationChoiceOption = {
  optionId: string | null;
  label: string | null;
  bridgeUnitRef: BridgeUnitRef;
};

export type ObservationChoiceEvent = {
  eventKind: "choice";
  bridgeUnitRef: BridgeUnitRef;
  prompt: string | null;
  options: ObservationChoiceOption[];
};

export type ObservationEvent = ObservationTextEvent | ObservationChoiceEvent;

export type ObservationEnvelope = {
  runtimeReportId: string | null;
  runtimeTargetId: string | null;
  evidenceTier: string | null;
  observationSource: string;
  events: ObservationEvent[];
};

export type CaptureArtifactRef = {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
  byteSize?: number;
};

export type CaptureRef = {
  captureId: string | null;
  frame: number | null;
  bridgeUnitRef: BridgeUnitRef;
  evidencesTraceEventId: string | null;
  artifactRef: CaptureArtifactRef;
  refHash: string;
  validated: boolean;
  validation: Record<string, boolean>;
};

export type ReviewAction = { action: string; label: string };

export type ProofLink = {
  source: string;
  proofKind?: string;
  proofId?: string;
  provenEvidenceTier?: string | null;
  patchedRuntimeObservationProven?: boolean;
  runtimeObservationProven?: boolean;
};

export type ValidationCheck = {
  checkId: string;
  status: "pass" | "fail";
  mandatory: boolean;
  detail: string;
};

export type DemoBundle = {
  schemaVersion: string;
  bundleKind: string;
  bundleId: string;
  engine: string;
  createdAt: string;
  bundleValid: boolean;
  provenEvidenceTier: string;
  sourceLocale: string;
  targetLocale: string;
  playbackSurface: {
    surfaceKind: string;
    runtimeTargetId: string | null;
    sourceRevision: { sourceId?: string; revisionId?: string } | null;
    live: boolean;
    public: boolean;
  };
  observationEnvelope: ObservationEnvelope;
  captureRefs: {
    availability: string;
    refs: CaptureRef[];
  };
  reviewManifest: {
    reviewPackageId: string | null;
    manifestKind: string | null;
    screenshotArtifactCount: number;
    supportedReviewActions: ReviewAction[] | null;
    source: string;
  };
  proofLinks: {
    patchedRuntimeProof: ProofLink;
    alphaProof: ProofLink;
    patchResult: Record<string, unknown>;
    screenshotEvidence: Record<string, unknown>;
  };
  validation: {
    bundleValid: boolean;
    checks: ValidationCheck[];
  };
  limitations: string[];
};

/**
 * Render the demo bundle into `root`. On schema-version or kind mismatch,
 * renders an error banner instead of the playback surface. Pure + synchronous:
 * no fetch, no live game, no painted pixels.
 */
export function renderDemoBundle(root: HTMLElement, bundle: DemoBundle): void {
  if (
    bundle.schemaVersion !== DEMO_BUNDLE_SCHEMA_VERSION ||
    bundle.bundleKind !== DEMO_BUNDLE_KIND
  ) {
    root.innerHTML = `
      <main style="${pageStyle()}" data-route="demo-bundle">
        <h1 style="margin: 0 0 .5rem">Utsushi Playback Demo</h1>
        <p role="alert" data-error="bundle-mismatch">
          ${escapeHtml(
            `utsushi.demo_bundle.mismatch: schemaVersion=${bundle.schemaVersion} bundleKind=${bundle.bundleKind} expected schema=${DEMO_BUNDLE_SCHEMA_VERSION} kind=${DEMO_BUNDLE_KIND}`,
          )}
        </p>
      </main>
    `;
    return;
  }
  root.innerHTML = `
    <main style="${pageStyle()}" data-route="demo-bundle" data-bundle-source="fixture" data-live="${bundle.playbackSurface.live}">
      <header style="margin-bottom: 1.5rem">
        <p style="margin: 0 0 .25rem; color: #53606f; font-size: .875rem">Embedded playback demo bundle</p>
        <h1 style="margin: 0 0 .5rem">Utsushi Playback Demo</h1>
        <p
          role="note"
          data-demo-fixture-notice
          style="margin: 0 0 .5rem; padding: .5rem .75rem; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; color: #4b5563"
        >
          Public synthetic MV/MZ fixture — NOT a live game. This surface renders a
          committed demo bundle that PACKAGES the UTSUSHI-119 / 102 / 065 / 010 proof
          artifacts. No game process runs and no copyrighted bytes or pixels are shown.
        </p>
        <p style="margin: 0; color: #4b5563">
          bundle ${escapeHtml(bundle.bundleId)} — ${escapeHtml(bundle.sourceLocale)} →
          ${escapeHtml(bundle.targetLocale)} — ${renderValidBadge(bundle.bundleValid)}
          ${bundle.bundleValid ? `<span style="margin-left:.5rem; color:#4b5563">tier ${escapeHtml(bundle.provenEvidenceTier)}</span>` : ""}
        </p>
      </header>
      ${renderPlaybackSurface(bundle)}
      ${renderObservationEnvelope(bundle.observationEnvelope)}
      ${renderCaptureRefs(bundle.captureRefs)}
      ${renderReviewManifest(bundle.reviewManifest)}
      ${renderProofLinks(bundle.proofLinks)}
      ${renderValidation(bundle.validation)}
      ${renderLimitations(bundle.limitations)}
    </main>
  `;
}

function renderPlaybackSurface(bundle: DemoBundle): string {
  const surface = bundle.playbackSurface;
  const liveLabel = surface.live
    ? `<span role="alert" style="color:#b91c1c">LIVE</span>`
    : `<span data-live-badge="false" style="color:#166534">no live game</span>`;
  return `
    <section aria-label="Playback surface" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Playback surface</h2>
      <dl style="${definitionGridStyle()}">
        ${field("Surface kind", surface.surfaceKind)}
        ${field("Runtime target", surface.runtimeTargetId)}
        ${field("Source revision", surface.sourceRevision?.sourceId ?? null)}
        <dt>Live game</dt><dd data-surface-live="${surface.live}">${liveLabel}</dd>
        ${field("Public fixture", String(surface.public))}
      </dl>
    </section>
  `;
}

function renderObservationEnvelope(envelope: ObservationEnvelope): string {
  if (envelope.events.length === 0) {
    return `
      <section aria-label="Observed dialogue" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Observed dialogue &amp; choices</h2>
        <p data-state="observation-empty">No observed events in this bundle.</p>
      </section>
    `;
  }
  return `
    <section aria-label="Observed dialogue" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Observed dialogue &amp; choices</h2>
      <p style="margin:0 0 .75rem; color:#4b5563">
        Evidence tier ${escapeHtml(envelope.evidenceTier ?? "missing")} —
        source ${escapeHtml(envelope.observationSource)} —
        report ${escapeHtml(envelope.runtimeReportId ?? "missing")}
      </p>
      <ol data-section="observation" style="padding-left:1.25rem; margin:0">
        ${envelope.events.map((event) => renderObservationEvent(event)).join("")}
      </ol>
    </section>
  `;
}

function renderObservationEvent(event: ObservationEvent): string {
  if (event.eventKind === "text") {
    return `
      <li data-event-kind="text" data-bridge-unit-id="${escapeHtml(event.bridgeUnitRef.bridgeUnitId ?? "")}" style="${itemStyle()}">
        <div>
          <strong>${escapeHtml(event.speaker ?? "narrator")}</strong>
          ${event.textSurface ? `<span style="margin-left:.5rem; color:#4b5563">${escapeHtml(event.textSurface)}</span>` : ""}
        </div>
        <p style="margin:.25rem 0 0">${escapeHtml(event.text ?? "")}</p>
        ${renderBridgeRef(event.bridgeUnitRef)}
      </li>
    `;
  }
  return `
    <li data-event-kind="choice" data-bridge-unit-id="${escapeHtml(event.bridgeUnitRef.bridgeUnitId ?? "")}" style="${itemStyle()}">
      <div><strong>${escapeHtml(event.prompt ?? "(choice)")}</strong></div>
      ${renderBridgeRef(event.bridgeUnitRef)}
      <ul data-section="choice-options" style="list-style:none; padding:0; margin:.5rem 0 0">
        ${event.options
          .map(
            (option) => `
              <li data-option-id="${escapeHtml(option.optionId ?? "")}" data-bridge-unit-id="${escapeHtml(option.bridgeUnitRef.bridgeUnitId ?? "")}" style="border-top:1px dashed #e5e7eb; padding:.4rem 0">
                <span>${escapeHtml(option.label ?? "")}</span>
                ${renderBridgeRef(option.bridgeUnitRef)}
              </li>
            `,
          )
          .join("")}
      </ul>
    </li>
  `;
}

function renderBridgeRef(ref: BridgeUnitRef): string {
  if (ref.bridgeUnitId === null && ref.sourceUnitKey === null) {
    return `<div role="alert" data-state="unlinked">observed event missing bridge unit ref</div>`;
  }
  return `
    <div data-bridge-ref style="margin-top:.25rem; color:#6b7280; font-size:.8125rem">
      bridge <code>${escapeHtml(ref.bridgeUnitId ?? "missing")}</code>
      → <code>${escapeHtml(ref.sourceUnitKey ?? "missing")}</code>
    </div>
  `;
}

function renderCaptureRefs(captureRefs: DemoBundle["captureRefs"]): string {
  if (captureRefs.refs.length === 0) {
    return `
      <section aria-label="Validated captures" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Validated captures</h2>
        <p data-state="captures-empty">Screenshot captures ${escapeHtml(captureRefs.availability)}.</p>
      </section>
    `;
  }
  return `
    <section aria-label="Validated captures" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Validated captures</h2>
      <ul data-section="captures" style="list-style:none; padding:0; margin:0">
        ${captureRefs.refs.map((capture) => renderCaptureRow(capture)).join("")}
      </ul>
    </section>
  `;
}

function renderCaptureRow(capture: CaptureRef): string {
  const managed = isManagedRuntimeUri(capture.artifactRef.uri);
  // Never paint pixels: the screenshot is surfaced only as a managed URI.
  const uriCell = managed
    ? `<code>${escapeHtml(capture.artifactRef.uri)}</code>`
    : `<span role="alert" data-state="blocked-uri">blocked non-managed uri</span>`;
  const validBadge = capture.validated
    ? `<span data-capture-validated="true" style="color:#166534">validated</span>`
    : `<span role="alert" data-capture-validated="false" style="color:#b91c1c">NOT validated</span>`;
  return `
    <li data-capture-id="${escapeHtml(capture.captureId ?? "")}" data-frame="${capture.frame ?? ""}" style="${itemStyle()}">
      <div style="display:flex; justify-content:space-between; gap:.75rem">
        <strong>frame ${capture.frame ?? "?"} — ${escapeHtml(capture.artifactRef.artifactKind)}</strong>
        ${validBadge}
      </div>
      <div style="margin-top:.25rem">${uriCell}</div>
      <div style="margin-top:.25rem; color:#6b7280; font-size:.8125rem">
        ref <code>${escapeHtml(capture.refHash)}</code>
      </div>
      ${renderBridgeRef(capture.bridgeUnitRef)}
      <div style="margin-top:.25rem; color:#6b7280; font-size:.8125rem">
        evidences trace event <code>${escapeHtml(capture.evidencesTraceEventId ?? "missing")}</code>
      </div>
    </li>
  `;
}

function renderReviewManifest(review: DemoBundle["reviewManifest"]): string {
  const actions = review.supportedReviewActions ?? [];
  return `
    <section aria-label="Review manifest" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Review manifest (${escapeHtml(review.source)})</h2>
      <dl style="${definitionGridStyle()}">
        ${field("Review package", review.reviewPackageId)}
        ${field("Manifest kind", review.manifestKind)}
        ${field("Screenshot refs", String(review.screenshotArtifactCount))}
      </dl>
      <ul data-section="review-actions" style="list-style:none; padding:0; margin:.5rem 0 0; display:flex; flex-wrap:wrap; gap:.5rem">
        ${actions
          .map(
            (action) =>
              `<li data-review-action="${escapeHtml(action.action)}" style="border:1px solid #d1d5db; border-radius:6px; padding:.25rem .5rem">${escapeHtml(action.label)}</li>`,
          )
          .join("")}
      </ul>
    </section>
  `;
}

function renderProofLinks(links: DemoBundle["proofLinks"]): string {
  return `
    <section aria-label="Proof links" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Proof links</h2>
      <ul data-section="proof-links" style="list-style:none; padding:0; margin:0">
        ${renderProofLinkRow("patched-runtime-proof", links.patchedRuntimeProof, links.patchedRuntimeProof.patchedRuntimeObservationProven ?? false)}
        ${renderProofLinkRow("alpha-proof", links.alphaProof, links.alphaProof.runtimeObservationProven ?? false)}
        ${renderPlainLinkRow("patch-result", "UTSUSHI-119 PatchResult", links.patchResult)}
        ${renderPlainLinkRow("screenshot-evidence", String(links.screenshotEvidence.source ?? "UTSUSHI-065"), links.screenshotEvidence)}
      </ul>
    </section>
  `;
}

function renderProofLinkRow(kind: string, link: ProofLink, proven: boolean): string {
  return `
    <li data-proof-link="${escapeHtml(kind)}" data-proof-source="${escapeHtml(link.source)}" style="${itemStyle()}">
      <div style="display:flex; justify-content:space-between; gap:.75rem">
        <strong>${escapeHtml(link.source)}</strong>
        ${
          proven
            ? `<span data-proof-proven="true" style="color:#166534">proven ${escapeHtml(link.provenEvidenceTier ?? "")}</span>`
            : `<span role="alert" data-proof-proven="false" style="color:#b91c1c">not proven</span>`
        }
      </div>
      <div style="color:#6b7280; font-size:.8125rem">
        ${escapeHtml(link.proofKind ?? "")} — <code>${escapeHtml(link.proofId ?? "missing")}</code>
      </div>
    </li>
  `;
}

function renderPlainLinkRow(kind: string, source: string, link: Record<string, unknown>): string {
  const entries = Object.entries(link)
    .filter(([key]) => key !== "source")
    .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(String(value))}`)
    .join(" · ");
  return `
    <li data-proof-link="${escapeHtml(kind)}" data-proof-source="${escapeHtml(source)}" style="${itemStyle()}">
      <strong>${escapeHtml(source)}</strong>
      <div style="color:#6b7280; font-size:.8125rem">${escapeHtml(entries)}</div>
    </li>
  `;
}

function renderValidation(validation: DemoBundle["validation"]): string {
  return `
    <section aria-label="Bundle validation" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Bundle validation — ${renderValidBadge(validation.bundleValid)}</h2>
      <ul data-section="validation" style="list-style:none; padding:0; margin:0">
        ${validation.checks
          .map(
            (check) => `
              <li data-check-id="${escapeHtml(check.checkId)}" data-check-status="${escapeHtml(check.status)}" style="${itemStyle()}">
                <div>
                  <strong>${escapeHtml(check.checkId)}</strong>
                  <span style="margin-left:.5rem; color:${check.status === "pass" ? "#166534" : "#b91c1c"}">${escapeHtml(check.status)}</span>
                </div>
                <p style="margin:.25rem 0 0; color:#4b5563">${escapeHtml(check.detail)}</p>
              </li>
            `,
          )
          .join("")}
      </ul>
    </section>
  `;
}

function renderLimitations(limitations: string[]): string {
  if (limitations.length === 0) {
    return "";
  }
  return `
    <section aria-label="Limitations" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Limitations</h2>
      <ul data-section="limitations" style="margin:0; padding-left:1.25rem; color:#4b5563">
        ${limitations.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderValidBadge(valid: boolean): string {
  return valid
    ? `<span data-bundle-valid="true" style="color:#166534">valid</span>`
    : `<span role="alert" data-bundle-valid="false" style="color:#b91c1c">invalid</span>`;
}

export function isManagedRuntimeUri(uri: string): boolean {
  return (
    uri.startsWith(RUNTIME_ARTIFACT_URI_ROOT) &&
    !uri.includes("\\") &&
    !uri.startsWith("/") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri) &&
    !uri.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function field(label: string, value: string | null): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "missing")}</dd>`;
}

function pageStyle(): string {
  return "font-family: system-ui, sans-serif; margin: 2rem; color: #111827; max-width: 1280px";
}

function panelStyle(): string {
  return "border: 1px solid #d1d5db; border-radius: 8px; padding: 1rem; margin-bottom: 1rem";
}

function headingStyle(): string {
  return "margin: 0 0 .75rem; font-size: 1.25rem";
}

function definitionGridStyle(): string {
  return "display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .35rem .75rem; margin: 0";
}

function itemStyle(): string {
  return "border-top: 1px solid #e5e7eb; padding: .75rem 0";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
