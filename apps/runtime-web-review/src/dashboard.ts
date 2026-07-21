type RuntimeStatus = {
  finalStatus: string;
  runtimeRunId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  evidenceTier: string | null;
  textEventCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
  traceEvents: RuntimeTraceRow[];
  findings: RuntimeFinding[];
  artifacts: RuntimeArtifact[];
  approximations: RuntimeApproximation[];
  unsupportedCapabilities: RuntimeUnsupportedCapability[];
  limitations: string[];
};

type RuntimeTraceRow = {
  runtimeEventId: string;
  eventKind: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  draftId: string | null;
  runtimeTargetId: string | null;
  evidenceTier: string | null;
  frame: number | null;
  textPreview: string | null;
  artifactIds: string[];
};

type RuntimeFinding = {
  findingId: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceTier: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  artifactId: string | null;
};

type RuntimeArtifact = {
  artifactId: string;
  artifactKind: string;
  uri: string | null;
  hash: string | null;
  hashProvenance: string | null;
  mediaType: string | null;
  byteSize: number | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  diagnostic: string | null;
};

type RuntimeApproximation = {
  approximationId: string;
  approximationTier: string;
  scope: string;
  description: string;
  evidenceTierCeiling: string;
  bridgeUnitIds: string[];
};

type RuntimeUnsupportedCapability = {
  feature: string;
  status: string;
  fidelityTierCeiling: string | null;
  evidenceTierCeiling: string | null;
  limitations: string[];
};

const DEFAULT_RUNTIME_STATUS_ENDPOINT = "/api/runtime/v0.2/status";

export async function fetchRuntimeStatus(
  endpoint = DEFAULT_RUNTIME_STATUS_ENDPOINT,
): Promise<RuntimeStatus> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : new URL(endpoint, window.location.href).toString();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load runtime status: ${response.status}`);
  }
  return (await response.json()) as RuntimeStatus;
}

export async function renderRuntimeDashboard(
  root: HTMLElement,
  endpoint = DEFAULT_RUNTIME_STATUS_ENDPOINT,
): Promise<void> {
  const routeRuntimeRunId = runtimeRunIdFromPath(window.location.pathname);
  root.innerHTML = `<main><h1>Utsushi Review</h1><p>Loading runtime evidence...</p></main>`;
  try {
    const status = await fetchRuntimeStatus(endpoint);
    root.innerHTML = renderRuntimeEvidence(status, routeRuntimeRunId);
  } catch (error) {
    root.innerHTML = `
      <main style="${pageStyle()}">
        <h1>Utsushi Review</h1>
        <p role="alert">Runtime dashboard could not load DB-backed status.</p>
        <pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
      </main>
    `;
  }
}

export async function renderRuntimeEvidenceRoute(
  root: HTMLElement,
  runtimeRunId: string,
  endpoint = DEFAULT_RUNTIME_STATUS_ENDPOINT,
): Promise<void> {
  await renderRuntimeDashboard(root, runtimeStatusEndpointForRun(endpoint, runtimeRunId));
}

function renderRuntimeEvidence(status: RuntimeStatus, routeRuntimeRunId: string | null): string {
  const requestedMismatch =
    routeRuntimeRunId !== null &&
    status.runtimeRunId !== null &&
    routeRuntimeRunId !== status.runtimeRunId;
  const artifactById = new Map(status.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  // Frame-capture / screenshot counts are DERIVED from the real runtime
  // artifacts persisted by the engine port's frame sink (artifact_kind
  // `frame_capture` / `screenshot` from the substrate render pipeline), NOT
  // from a scalar summary counter. The historical scalar counters double-
  // counted a single capture (frameCaptureCount === screenshotArtifactCount
  // === total captures), so they were phantom/always-derivable numbers rather
  // than a measurement of the artifacts that actually exist. Counting the real
  // artifacts keeps each metric backed by a real producer.
  const frameCaptureCount = countArtifactsByKind(status.artifacts, "frame_capture");
  const screenshotCount = countArtifactsByKind(status.artifacts, "screenshot");
  return `
    <main style="${pageStyle()}" data-route="runtime-evidence">
      <header style="margin-bottom: 1.5rem">
        <p style="margin: 0 0 .25rem; color: #53606f; font-size: .875rem">Runtime evidence</p>
        <h1 style="margin: 0 0 .5rem">Utsushi Review</h1>
        ${requestedMismatch ? diagnostic("Loaded latest run differs from route run id.") : ""}
      </header>
      <section aria-label="Runtime summary" style="${panelStyle()}">
        <h2 style="${headingStyle()}">${escapeHtml(status.runtimeStatus ?? "missing")}</h2>
        <dl style="${definitionGridStyle()}">
          ${field("Runtime run", status.runtimeRunId)}
          ${field("Report", status.runtimeReportId)}
          ${field("Suite", status.finalStatus)}
          ${field("Fidelity tier", status.fidelityTier)}
          ${field("Evidence tier", status.evidenceTier)}
          ${field("Trace text events", String(status.textEventCount))}
          ${metricField("Frame captures", "frame-captures", frameCaptureCount)}
          ${metricField("Screenshots", "screenshots", screenshotCount)}
          ${field("Recordings", String(status.recordingArtifactCount))}
          ${field("Validation findings", String(status.validationFindingCount))}
        </dl>
      </section>
      ${renderTraceTable(status.traceEvents, artifactById)}
      ${renderDetailPane(status)}
      ${renderArtifactTable(status.artifacts)}
    </main>
  `;
}

function renderTraceTable(
  traceEvents: RuntimeTraceRow[],
  artifactById: Map<string, RuntimeArtifact>,
): string {
  const rows =
    traceEvents.length === 0
      ? `<tr><td colspan="9">No runtime trace rows returned.</td></tr>`
      : traceEvents
          .map(
            (event) => `
              <tr>
                <td>${escapeHtml(event.runtimeEventId)}</td>
                <td>${escapeHtml(event.eventKind)}</td>
                <td>${escapeHtml(event.bridgeUnitId ?? "missing")}</td>
                <td>${escapeHtml(event.sourceUnitKey ?? "missing")}</td>
                <td>${escapeHtml(event.runtimeTargetId ?? "missing")}</td>
                <td>${escapeHtml(event.evidenceTier ?? "report")}</td>
                <td>${event.frame ?? "missing"}</td>
                <td>${escapeHtml(preview(event.textPreview))}<div style="color:#6b7280">${escapeHtml(event.draftId ?? "draft missing")}</div></td>
                <td>${renderArtifactLinks(event.artifactIds, artifactById)}</td>
              </tr>
            `,
          )
          .join("");

  return `
    <section aria-label="Runtime trace" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Trace</h2>
      <div style="overflow-x:auto">
        <table style="${tableStyle()}">
          <thead>
            <tr>
              <th>Event id</th>
              <th>Event kind</th>
              <th>Bridge unit id</th>
              <th>Source unit key</th>
              <th>Runtime target id</th>
              <th>Evidence tier</th>
              <th>Frame</th>
              <th>Text preview</th>
              <th>Artifact links</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderDetailPane(status: RuntimeStatus): string {
  return `
    <aside aria-label="Runtime detail" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Detail</h2>
      ${renderFindings(status.findings)}
      ${renderApproximations(status.approximations)}
      ${renderUnsupportedCapabilities(status.unsupportedCapabilities)}
      ${renderList("Limitations", status.limitations)}
    </aside>
  `;
}

function renderFindings(findings: RuntimeFinding[]): string {
  if (findings.length === 0) {
    return `<section><h3 style="${subheadingStyle()}">Findings</h3><p>No validation findings.</p></section>`;
  }
  return `
    <section>
      <h3 style="${subheadingStyle()}">Findings</h3>
      ${findings
        .map(
          (finding) => `
            <article style="${itemStyle()}">
              <strong>${escapeHtml(finding.findingKind)}</strong>
              <dl style="${compactDefinitionStyle()}">
                ${field("Severity", finding.severity)}
                ${field("Evidence tier", finding.evidenceTier)}
                ${field("Bridge unit", finding.bridgeUnitId)}
                ${field("Source unit", finding.sourceUnitKey)}
                ${field("Artifact", finding.artifactId)}
              </dl>
              <p>${escapeHtml(finding.message)}</p>
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderApproximations(approximations: RuntimeApproximation[]): string {
  if (approximations.length === 0) {
    return `<section><h3 style="${subheadingStyle()}">Approximations</h3><p>No approximations reported.</p></section>`;
  }
  return `
    <section>
      <h3 style="${subheadingStyle()}">Approximations</h3>
      ${approximations
        .map(
          (approximation) => `
            <article style="${itemStyle()}">
              <strong>${escapeHtml(approximation.approximationTier)}</strong>
              <dl style="${compactDefinitionStyle()}">
                ${field("Scope", approximation.scope)}
                ${field("Evidence ceiling", approximation.evidenceTierCeiling)}
                ${field("Bridge units", approximation.bridgeUnitIds.join(", "))}
              </dl>
              <p>${escapeHtml(approximation.description)}</p>
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderUnsupportedCapabilities(capabilities: RuntimeUnsupportedCapability[]): string {
  if (capabilities.length === 0) {
    return `<section><h3 style="${subheadingStyle()}">Unsupported capabilities</h3><p>No unsupported capabilities reported.</p></section>`;
  }
  return `
    <section>
      <h3 style="${subheadingStyle()}">Unsupported capabilities</h3>
      ${capabilities
        .map(
          (capability) => `
            <article style="${itemStyle()}">
              <strong>${escapeHtml(capability.feature)}</strong>
              <dl style="${compactDefinitionStyle()}">
                ${field("Status", capability.status)}
                ${field("Fidelity ceiling", capability.fidelityTierCeiling)}
                ${field("Evidence ceiling", capability.evidenceTierCeiling)}
              </dl>
              ${renderList("Capability limitations", capability.limitations)}
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderArtifactTable(artifacts: RuntimeArtifact[]): string {
  const rows =
    artifacts.length === 0
      ? `<tr><td colspan="9">No artifact records returned.</td></tr>`
      : artifacts
          .map(
            (artifact) => `
              <tr>
                <td>${escapeHtml(artifact.artifactId)}</td>
                <td>${escapeHtml(artifact.artifactKind)}</td>
                <td>${renderManagedArtifactLink(artifact)}</td>
                <td>${escapeHtml(artifact.hash ?? "missing")}</td>
                <td>${renderHashProvenance(artifact)}</td>
                <td>${escapeHtml(artifact.mediaType ?? "missing")}</td>
                <td>${artifact.byteSize ?? "missing"}</td>
                <td>${escapeHtml(artifact.bridgeUnitId ?? "missing")}</td>
                <td>${artifact.diagnostic === null ? "ok" : diagnostic(artifact.diagnostic)}</td>
              </tr>
            `,
          )
          .join("");
  return `
    <section aria-label="Runtime artifacts" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Artifacts</h2>
      <div style="overflow-x:auto">
        <table style="${tableStyle()}">
          <thead>
            <tr>
              <th>Artifact id</th>
              <th>Kind</th>
              <th>Managed link</th>
              <th>Hash</th>
              <th>Hash provenance</th>
              <th>MIME type</th>
              <th>Bytes</th>
              <th>Bridge unit</th>
              <th>Diagnostic</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderArtifactLinks(
  artifactIds: string[],
  artifactById: Map<string, RuntimeArtifact>,
): string {
  if (artifactIds.length === 0) {
    return "none";
  }
  return artifactIds
    .map((artifactId) => {
      const artifact = artifactById.get(artifactId);
      if (artifact === undefined) {
        return diagnostic(`missing artifact record: ${artifactId}`);
      }
      return renderManagedArtifactLink(artifact);
    })
    .join("<br>");
}

function renderManagedArtifactLink(artifact: RuntimeArtifact): string {
  const uri = artifact.uri;
  if (artifact.diagnostic !== null) {
    return diagnostic(artifact.diagnostic);
  }
  if (uri === null || !isManagedArtifactUri(uri)) {
    return diagnostic("blocked unmanaged artifact link");
  }
  if (artifact.hash === null) {
    return diagnostic("managed artifact link missing content hash");
  }
  // A repository-generated placeholder hash is structurally a valid managed
  // link, but it is NOT authentic content evidence. Render the link with an
  // inline placeholder badge so the dashboard cannot be mistaken for content
  // proof. Content-backed hashes render as a plain link.
  if (artifact.hashProvenance === "repository_fallback") {
    return `<a href="${escapeHtml(managedArtifactUrl(uri))}" target="_blank" rel="noreferrer">${escapeHtml(uri)}</a> ${placeholderBadge("generated placeholder hash")}`;
  }
  return `<a href="${escapeHtml(managedArtifactUrl(uri))}" target="_blank" rel="noreferrer">${escapeHtml(uri)}</a>`;
}

function renderHashProvenance(artifact: RuntimeArtifact): string {
  if (artifact.hash === null) {
    return escapeHtml("missing");
  }
  // Surface the provenance discriminator the repository attaches to every
  // runtime artifact hash. Content-backed hashes are authentic adapter
  // evidence; repository_fallback hashes are deterministic placeholders over
  // managed-artifact metadata and must not be presented as content proof.
  if (artifact.hashProvenance === "content") {
    return provenanceBadge("content", "#065f46");
  }
  if (artifact.hashProvenance === "repository_fallback") {
    return provenanceBadge("repository_fallback", "#92400e");
  }
  return escapeHtml("unknown");
}

function placeholderBadge(label: string): string {
  return `<span role="status" style="color:#92400e; font-weight:600">${escapeHtml(label)}</span>`;
}

function provenanceBadge(value: string, color: string): string {
  return `<span data-provenance="${escapeHtml(value)}" style="color:${color}; font-weight:600">${escapeHtml(value)}</span>`;
}

function renderList(title: string, values: string[]): string {
  if (values.length === 0) {
    return `<section><h3 style="${subheadingStyle()}">${escapeHtml(title)}</h3><p>None.</p></section>`;
  }
  return `
    <section>
      <h3 style="${subheadingStyle()}">${escapeHtml(title)}</h3>
      <ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>
    </section>
  `;
}

function field(label: string, value: string | null): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "missing")}</dd>`;
}

// A capture metric whose value is derived from the real runtime artifact list
// (not a scalar summary counter). The `data-metric` hook lets tests assert the
// rendered number reflects the actual producer count rather than a phantom
// always-zero / double-counted scalar.
function metricField(label: string, metricId: string, count: number): string {
  return `<dt>${escapeHtml(label)}</dt><dd data-metric="${escapeHtml(metricId)}">${count}</dd>`;
}

function countArtifactsByKind(artifacts: RuntimeArtifact[], artifactKind: string): number {
  return artifacts.filter((artifact) => artifact.artifactKind === artifactKind).length;
}

function diagnostic(value: string): string {
  return `<span role="status" style="color:#b91c1c; font-weight:600">${escapeHtml(value)}</span>`;
}

export function runtimeRunIdFromPath(pathname: string): string | null {
  const match = /^\/runtime\/evidence\/([^/]+)\/?$/u.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1] ?? "");
}

function runtimeStatusEndpointForRun(endpoint: string, runtimeRunId: string): string {
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set("runtimeRunId", runtimeRunId);
  return endpoint.startsWith("http") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function isManagedArtifactUri(uri: string): boolean {
  return (
    uri.startsWith("artifacts/utsushi/runtime/") &&
    !uri.includes("\\") &&
    !uri.startsWith("/") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri) &&
    !uri.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function managedArtifactUrl(uri: string): string {
  return `/artifact-store/${uri}`;
}

function preview(value: string | null): string {
  if (value === null || value.length <= 96) {
    return value ?? "missing";
  }
  return `${value.slice(0, 93)}...`;
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

function subheadingStyle(): string {
  return "margin: 1rem 0 .5rem; font-size: 1rem";
}

function definitionGridStyle(): string {
  return "display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .35rem .75rem; margin: 0";
}

function compactDefinitionStyle(): string {
  return "display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .5rem; margin: .5rem 0";
}

function tableStyle(): string {
  return "border-collapse: collapse; width: 100%; font-size: .875rem";
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
