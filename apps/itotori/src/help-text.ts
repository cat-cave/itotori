// beta-packaged-install-surface — the coherent user-facing CLI help text.
//
// The CLI previously had ~40 developer stage-commands with no --help and no
// coherent user surface. This module owns the single source of truth for the
// help text that `itotori --help`, `itotori -h`, and `itotori help` print.
//
// The help groups commands into user-facing categories (setup, localization,
// global flags) rather than listing every internal stage-command. A developer
// who needs the full command list can run `itotori help --all`.

import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";

export function buildHelpText(allCommands = false): string {
  const lines: string[] = [];
  lines.push(`itotori ${ITOTORI_PRODUCT_VERSION} — agentic games-localization pipeline`);
  lines.push("");
  lines.push("USAGE:");
  lines.push("  itotori <command> [flags]");
  lines.push("");

  lines.push("SETUP:");
  lines.push("  init                    Guided setup: OpenRouter key, ZDR posture,");
  lines.push("                          config file, and database footprint.");
  lines.push("  db-migrate              Run database migrations.");
  lines.push("  db-reset                Reset the database (destroys all data).");
  lines.push("");

  lines.push("LOCALIZATION:");
  lines.push("  localize-game           Localize a whole game end-to-end");
  lines.push("                          (extract → structure → localize → patch → validate).");
  lines.push(
    "                          --allow-partial-patch  Produce a PREVIEW patch from a partial/bounded run (undrafted units pass through byte-identical). Default: refuse partial coverage (release safety).",
  );
  lines.push(
    "                          --resume-run-id <ID>  Resume a paused run from its first pending unit, or finish a durable finalizing commit.",
  );
  lines.push("  extract                 Extract a bridge bundle from a game.");
  lines.push("  structure-export        Export narrative structure from a game.");
  lines.push("  localize                Run the whole-project localization driver.");
  lines.push(
    "                          --allow-partial-patch  Produce a PREVIEW patch from a partial/bounded run (undrafted units pass through byte-identical). Default: refuse partial coverage (release safety).",
  );
  lines.push(
    "                          --resume-run-id <ID>  Resume a paused run from its first pending unit, or finish a durable finalizing commit.",
  );
  lines.push(
    "                          --cancel --resume-run-id <ID> --run-dir <PATH>  Abort an existing run without invoking a provider; --config is not required.",
  );
  lines.push("  patch                   Apply a translation patch to a game.");
  lines.push("  validate                Validate a patched game (replay + render).");
  lines.push("");

  if (allCommands) {
    lines.push("ADVANCED:");
    lines.push("  dashboard-status        Write dashboard status JSON.");
    lines.push(
      "  localize-project-stage  Run one durably-accounted agentic-loop stage (live; --cost-cap-usd applies a run cap).",
    );
    lines.push("  export-patch-v2         Export a v0.2 patch bundle from drafts.");
    lines.push("  ingest-runtime          Ingest a runtime evidence report.");
    lines.push("  ingest-patch-result     Ingest a patch result.");
    lines.push("  ingest-conformance      Ingest a conformance report.");
    lines.push("  import-feedback         Import manual feedback.");
    lines.push("  import-channel-feedback Import a community-channel export.");
    lines.push("  import-feedback-batch   Import a batch of feedback.");
    lines.push("  catalog-link-exact      Link external IDs to catalog works.");
    lines.push("  catalog-fuzzy-candidates  Generate fuzzy catalog candidates.");
    lines.push("  catalog-local-scan      Scan a local corpus root.");
    lines.push("  plan-batches            Plan translation batches.");
    lines.push("  generate-scene-summaries  Generate scene summaries (live).");
    lines.push("  check-scene-summaries   Check scene summary staleness.");
    lines.push("  generate-character-relationships  Generate character bios (live).");
    lines.push("  check-character-relationships  Check character relationship staleness.");
    lines.push("  engine-capabilities-record  Record an engine capability matrix.");
    lines.push("  engine-capabilities-list  List engine capability matrices.");
    lines.push("  asset-decisions-list    List asset localization decisions.");
    lines.push("  asset-decisions-record  Record an asset localization decision.");
    lines.push("  telemetry-summary       Summarize provider telemetry.");
    lines.push("  benchmark-harness-run   Run the benchmark harness.");
    lines.push("  experiment-report-compose  Compose an experiment report.");
    lines.push("  alpha-readiness-run     Run the alpha readiness composition.");
    lines.push("  vision-inspect          Run a vision-gate inspection.");
    lines.push("  reconcile-ledger-cost   Reconcile ledger cost against OpenRouter.");
    lines.push("  queue-health            Report queue health.");
    lines.push("  provider-proof          Run a provider proof (recorded or --live).");
    lines.push("  provider-proof-bundle   Run a sanitized provider-proof bundle.");
    lines.push("  raw-mtl-baseline-proof  Run the raw-MTL baseline proof.");
    lines.push("  agentic-loop-smoke      Run an agentic-loop smoke test.");
    lines.push("  catalog-resolve-fixture Run the catalog resolver fixture.");
    lines.push("  style-guide-fixture-flow  Run the style-guide fixture flow.");
    lines.push("");
  }

  lines.push("GLOBAL FLAGS:");
  lines.push("  --help, -h              Print this help text.");
  lines.push("  --version, -v           Print the itotori version.");
  lines.push("  --env-file <path>       Load allowlisted live-provider vars from an env file.");
  lines.push("");

  if (allCommands) {
    lines.push("  help --all              Show all commands including advanced/internal.");
    lines.push("");
  }

  lines.push("EXAMPLES:");
  lines.push("  itotori init                      # guided setup");
  lines.push("  itotori --help                    # this help");
  lines.push("  itotori --version                 # version");
  lines.push("  itotori db-migrate                # run database migrations");
  lines.push("  itotori localize-game \\");
  lines.push("    --config <config.json> \\");
  lines.push("    --source <game-root> \\");
  lines.push("    --target <output-root> \\");
  lines.push("    --run-dir <run-dir> \\");
  lines.push("    --game-id <id> --game-version <ver> \\");
  lines.push("    --source-profile-id <profile> --source-locale ja-JP \\");
  lines.push("    --scene <N>");
  lines.push("");

  lines.push("See docs/install.md for the full install path and");
  lines.push("    docs/security-and-limitations.md for the security posture.");

  return lines.join("\n");
}

export const ITOTORI_HELP_TEXT = buildHelpText(false);
