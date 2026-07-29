export function pageStyle(): string {
  return "font-family: system-ui, sans-serif; margin: 2rem; color: #111827; max-width: 1280px";
}

export function panelStyle(): string {
  return "border: 1px solid #d1d5db; border-radius: 8px; padding: 1rem; margin-bottom: 1rem";
}

export function headingStyle(): string {
  return "margin: 0 0 .75rem; font-size: 1.25rem";
}

export function definitionGridStyle(): string {
  return "display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .35rem .75rem; margin: 0";
}

export function itemStyle(): string {
  return "border-top: 1px solid #e5e7eb; padding: .75rem 0";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
