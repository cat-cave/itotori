// WASM embed ABI fixture renderer.
//
// Consumes a canned `EmbedState` JSON envelope and renders the four ABI
// observables (capabilities, trace, current snapshot ref, artifact refs).
// Does NOT load a WASM bundle in this slice; the JSON wire form is the
// stable contract and the Rust `EmbedState::to_json_value` is the producer.

export const EMBED_SCHEMA_VERSION = "0.1.0-alpha";
export const RUNTIME_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime/";

export type EmbedCapabilityId =
  | "state"
  | "trace"
  | "snapshot"
  | "artifact_refs"
  | "deterministic_fixture";

export type EmbedCapabilityStatus = "supported" | "partial" | "unsupported";

export type EmbedCapability = {
  capabilityId: EmbedCapabilityId;
  status: EmbedCapabilityStatus;
  evidenceTierCeiling?: string;
  limitations?: string[];
};

export type EmbedTraceLine = {
  lineId: string;
  evidenceTier: string;
  text: string;
  speaker?: string;
  textSurface?: string;
  bridgeRef?: {
    bridgeUnitId?: string;
    sourceUnitKey?: string;
    runtimeObjectId?: string;
  };
  sourceAsset?: string;
};

export type EmbedTrace = {
  schemaVersion: string;
  lines: EmbedTraceLine[];
};

export type EmbedSnapshotRef = {
  snapshotId: string;
  adapterId: string;
  contentHash: string;
  sizeBytes: number;
  evidenceTier: string;
};

export type EmbedArtifactRef = {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
};

export type EmbedState = {
  schemaVersion: string;
  adapterId: string;
  adapterVersion: string;
  capabilities: EmbedCapability[];
  trace: EmbedTrace;
  currentSnapshot?: EmbedSnapshotRef;
  artifactRefs?: EmbedArtifactRef[];
};

/**
 * Capability-gated read: returns the trace iff `Capability::Trace` is
 * declared `supported | partial`. Otherwise returns a typed error message
 * mirroring `EmbedError::CapabilityNotSupported`.
 */
export function readTrace(state: EmbedState): EmbedTrace | { error: string } {
  if (!isCapabilityAvailable(state, "trace")) {
    return { error: "utsushi.embed.capability_not_supported: capability_id=trace" };
  }
  return state.trace;
}

export function readSnapshot(state: EmbedState): EmbedSnapshotRef | null | { error: string } {
  if (!isCapabilityAvailable(state, "snapshot")) {
    return { error: "utsushi.embed.capability_not_supported: capability_id=snapshot" };
  }
  return state.currentSnapshot ?? null;
}

export function readArtifactRefs(state: EmbedState): EmbedArtifactRef[] | { error: string } {
  if (!isCapabilityAvailable(state, "artifact_refs")) {
    return {
      error: "utsushi.embed.capability_not_supported: capability_id=artifact_refs",
    };
  }
  return state.artifactRefs ?? [];
}

export function isCapabilityAvailable(state: EmbedState, capabilityId: EmbedCapabilityId): boolean {
  const capability = state.capabilities.find((entry) => entry.capabilityId === capabilityId);
  if (capability === undefined) {
    return false;
  }
  return capability.status === "supported" || capability.status === "partial";
}

/**
 * Render an EmbedState JSON envelope into the supplied container element.
 * On schema-version mismatch, renders an error banner instead of the
 * observable surface.
 */
export function renderEmbedState(root: HTMLElement, state: EmbedState): void {
  if (state.schemaVersion !== EMBED_SCHEMA_VERSION) {
    root.innerHTML = `
      <main style="${pageStyle()}" data-route="embed-state">
        <h1 style="margin: 0 0 .5rem">Utsushi Embed</h1>
        <p role="alert" data-error="schema-version-mismatch">
          ${escapeHtml(
            `utsushi.embed.schema_version_mismatch: observed=${state.schemaVersion} expected=${EMBED_SCHEMA_VERSION}`,
          )}
        </p>
      </main>
    `;
    return;
  }
  root.innerHTML = `
    <main style="${pageStyle()}" data-route="embed-state" data-embed-source="fixture">
      <header style="margin-bottom: 1.5rem">
        <p style="margin: 0 0 .25rem; color: #53606f; font-size: .875rem">Embed ABI fixture</p>
        <h1 style="margin: 0 0 .5rem">Utsushi Embed</h1>
        <p
          role="note"
          data-embed-fixture-notice
          style="margin: 0 0 .5rem; padding: .5rem .75rem; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; color: #4b5563"
        >
          Deterministic ABI fixture — NOT live runtime state. This view renders a
          canned <code>EmbedState</code> envelope (the stable JSON wire contract),
          not a measurement of a running engine port.
        </p>
        <p style="margin: 0; color: #4b5563">
          ${escapeHtml(state.adapterId)} v${escapeHtml(state.adapterVersion)} —
          schema ${escapeHtml(state.schemaVersion)}
        </p>
      </header>
      ${renderCapabilities(state)}
      ${renderTrace(state)}
      ${renderCurrentSnapshot(state)}
      ${renderArtifactRefs(state)}
    </main>
  `;
}

function renderCapabilities(state: EmbedState): string {
  return `
    <section aria-label="Capabilities" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Capabilities</h2>
      <ul data-section="capabilities" style="list-style:none; padding:0; margin:0">
        ${state.capabilities.map((capability) => renderCapabilityRow(state, capability)).join("")}
      </ul>
    </section>
  `;
}

function renderCapabilityRow(state: EmbedState, capability: EmbedCapability): string {
  const disabled = capability.status === "unsupported" ? "disabled" : "";
  const buttonLabel = capabilityActionLabel(capability.capabilityId);
  const isSnapshotAction = capability.capabilityId === "snapshot";
  return `
    <li data-capability-id="${escapeHtml(capability.capabilityId)}" style="${itemStyle()}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem">
        <div>
          <strong>${escapeHtml(capability.capabilityId)}</strong>
          <span style="margin-left:.5rem; color:#4b5563">${escapeHtml(capability.status)}</span>
          ${
            capability.evidenceTierCeiling
              ? `<span style="margin-left:.5rem; color:#4b5563">ceiling ${escapeHtml(capability.evidenceTierCeiling)}</span>`
              : ""
          }
        </div>
        ${
          buttonLabel
            ? `<button data-action="${escapeHtml(capability.capabilityId)}" ${disabled}>${escapeHtml(buttonLabel)}</button>`
            : ""
        }
      </div>
      ${renderLimitations(capability.limitations)}
      ${isSnapshotAction ? renderSnapshotInline(state, capability) : ""}
    </li>
  `;
}

function renderSnapshotInline(state: EmbedState, capability: EmbedCapability): string {
  if (capability.status !== "unsupported") {
    return "";
  }
  return `<p data-snapshot-disabled-reason style="margin:.25rem 0 0; color:#b91c1c">
    Snapshot capability is unsupported; the host UI MUST render this reason.
    ${state.currentSnapshot ? "" : "No snapshot reference attached."}
  </p>`;
}

function capabilityActionLabel(capabilityId: EmbedCapabilityId): string | null {
  switch (capabilityId) {
    case "state":
      return null;
    case "trace":
      return "view trace";
    case "snapshot":
      return "show snapshot";
    case "artifact_refs":
      return "list artifacts";
    case "deterministic_fixture":
      return null;
  }
}

function renderLimitations(limitations: string[] | undefined): string {
  if (limitations === undefined || limitations.length === 0) {
    return "";
  }
  return `
    <ul data-section="limitations" style="margin:.5rem 0 0; padding-left:1.25rem; color:#4b5563">
      ${limitations.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}
    </ul>
  `;
}

function renderTrace(state: EmbedState): string {
  const result = readTrace(state);
  if ("error" in result) {
    return `
      <section aria-label="Trace" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Trace</h2>
        <p data-state="trace-unsupported" role="status">${escapeHtml(result.error)}</p>
      </section>
    `;
  }
  if (result.lines.length === 0) {
    return `
      <section aria-label="Trace" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Trace</h2>
        <p data-state="trace-empty">No trace lines emitted yet.</p>
      </section>
    `;
  }
  return `
    <section aria-label="Trace" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Trace</h2>
      <ol data-section="trace" style="padding-left:1.25rem; margin:0">
        ${result.lines.map((line) => renderTraceLine(line)).join("")}
      </ol>
    </section>
  `;
}

function renderTraceLine(line: EmbedTraceLine): string {
  return `
    <li data-line-id="${escapeHtml(line.lineId)}" style="${itemStyle()}">
      <div>
        <strong>${escapeHtml(line.speaker ?? "narrator")}</strong>
        <span style="margin-left:.5rem; color:#4b5563">${escapeHtml(line.evidenceTier)}</span>
        ${
          line.textSurface
            ? `<span style="margin-left:.5rem; color:#4b5563">surface ${escapeHtml(line.textSurface)}</span>`
            : ""
        }
      </div>
      <p style="margin:.25rem 0 0">${escapeHtml(line.text)}</p>
    </li>
  `;
}

function renderCurrentSnapshot(state: EmbedState): string {
  const result = readSnapshot(state);
  if (result !== null && "error" in result) {
    return `
      <section aria-label="Current snapshot" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Current snapshot</h2>
        <p data-state="snapshot-unsupported" role="status">${escapeHtml(result.error)}</p>
      </section>
    `;
  }
  if (result === null) {
    return `
      <section aria-label="Current snapshot" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Current snapshot</h2>
        <p data-state="snapshot-empty">No current snapshot recorded.</p>
      </section>
    `;
  }
  return `
    <section aria-label="Current snapshot" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Current snapshot</h2>
      <dl data-section="snapshot" style="margin:0">
        <dt>Snapshot id</dt><dd>${escapeHtml(result.snapshotId)}</dd>
        <dt>Adapter</dt><dd>${escapeHtml(result.adapterId)}</dd>
        <dt>Content hash</dt><dd><code>${escapeHtml(result.contentHash)}</code></dd>
        <dt>Size (bytes)</dt><dd>${result.sizeBytes}</dd>
        <dt>Evidence tier</dt><dd>${escapeHtml(result.evidenceTier)}</dd>
      </dl>
    </section>
  `;
}

function renderArtifactRefs(state: EmbedState): string {
  const result = readArtifactRefs(state);
  if (!Array.isArray(result) && "error" in result) {
    return `
      <section aria-label="Artifact refs" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Artifact refs</h2>
        <p data-state="artifacts-unsupported" role="status">${escapeHtml(result.error)}</p>
      </section>
    `;
  }
  const list = result as EmbedArtifactRef[];
  if (list.length === 0) {
    return `
      <section aria-label="Artifact refs" style="${panelStyle()}">
        <h2 style="${headingStyle()}">Artifact refs</h2>
        <p data-state="artifacts-empty">No artifact refs declared.</p>
      </section>
    `;
  }
  return `
    <section aria-label="Artifact refs" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Artifact refs</h2>
      <ul data-section="artifact-refs" style="list-style:none; padding:0; margin:0">
        ${list.map((entry) => renderArtifactRow(entry)).join("")}
      </ul>
    </section>
  `;
}

function renderArtifactRow(artifact: EmbedArtifactRef): string {
  const safe = isManagedRuntimeUri(artifact.uri);
  return `
    <li data-artifact-id="${escapeHtml(artifact.artifactId)}" style="${itemStyle()}">
      <strong>${escapeHtml(artifact.artifactKind)}</strong>
      ${
        safe
          ? `<div><code>${escapeHtml(artifact.uri)}</code></div>`
          : `<div role="alert" data-state="blocked-uri">blocked non-managed uri</div>`
      }
      ${
        artifact.mediaType
          ? `<div style="color:#4b5563">${escapeHtml(artifact.mediaType)}</div>`
          : ""
      }
    </li>
  `;
}

function isManagedRuntimeUri(uri: string): boolean {
  return (
    uri.startsWith(RUNTIME_ARTIFACT_URI_ROOT) &&
    !uri.includes("\\") &&
    !uri.startsWith("/") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri) &&
    !uri.split("/").some((segment) => segment === "." || segment === "..")
  );
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
