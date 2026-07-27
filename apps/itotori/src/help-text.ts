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
  lines.push("  extract                 Extract a bridge bundle from a game.");
  lines.push(
    "  structure-export        Export narrative structure (--engine <provider> required).",
  );
  lines.push("  localize                Run the whole-project localization driver (new pipeline).");
  lines.push(
    "                          --run-mode production|pilot|test-dev  Operational posture (gates legality).",
  );
  lines.push(
    "                          --structure <PATH>  Decoded narrative-structure JSON (decode→scene projection input).",
  );
  lines.push(
    "                          [--context-scope <scope>] [--output-scope <scope>] [--whole-scene-max-units <N>] [--output <JSON>].",
  );
  lines.push(
    "  localize-portfolio      Run independent localization drivers from a JSON portfolio.",
  );
  lines.push(
    "                          --portfolio <JSON> [--max-in-flight <N>] [--output <JSON>] (each run supplies identity, paths, mode, output scope, and costCapMicrosUsd).",
  );
  lines.push("  patch                   Apply a translation patch to a game.");
  lines.push(
    "  patch produce           Produce a persistent patched build from accepted outputs (same native seam as Studio download).",
  );
  lines.push(
    "                          --input <JSON> --source <RO game> --build-root <RW dir> --scope dialogue-only|dialogue+choices --output <receipt JSON>.",
  );
  lines.push("  validate                Validate a patched game (replay + render).");
  lines.push("");

  lines.push("PATCH PLAY:");
  lines.push(
    "  patch play <VERSION>    Launch the exact hash-bound patch through the real replay runtime and return a launch receipt.",
  );
  lines.push("");

  lines.push("WIKI:");
  lines.push(
    "  wiki build              Build the source-language bible (A1-A10; --structure <JSON> --bridge <JSON> --source-locale <LOCALE> --run-mode <MODE>).",
  );
  lines.push(
    "  wiki list               List the current head of every object under a snapshot (--snapshot <ID>).",
  );
  lines.push(
    "  wiki show               Show one object's view, history, and dependents (--wiki-kind <KIND> --object-id <ID>).",
  );
  lines.push(
    "  wiki history            Show one object's immutable version history (--wiki-kind <KIND> --object-id <ID>).",
  );
  lines.push(
    "  wiki edit               Append a guarded direct edit (--candidate-json <JSON> --created-at <ISO> [--assert-category <C>]).",
  );
  lines.push(
    "                          Common: [--output <JSON>]. --wiki-kind is source-object|translation-object|localized-rendering.",
  );
  lines.push("");

  if (allCommands) {
    lines.push("ADVANCED:");
    lines.push("  dashboard-status        Write dashboard status JSON.");
    lines.push("  ingest-runtime          Ingest a runtime evidence report.");
    lines.push("  ingest-patch-result     Ingest a patch result.");
    lines.push("  ingest-conformance      Ingest a conformance report.");
    lines.push("  catalog-link-exact      Link external IDs to catalog works.");
    lines.push("  catalog-fuzzy-candidates  Generate fuzzy catalog candidates.");
    lines.push("  catalog-local-scan      Scan a local corpus root.");
    lines.push("  engine-capabilities-record  Record an engine capability matrix.");
    lines.push("  engine-capabilities-list  List engine capability matrices.");
    lines.push("  asset-decisions-list    List asset localization decisions.");
    lines.push("  queue-health            Report queue health.");
    lines.push("  catalog-resolve-fixture Run the catalog resolver fixture.");
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
  lines.push(
    "  itotori wiki build --structure <structure.json> --bridge <bridge.json> --source-locale <locale> --run-mode production",
  );
  lines.push("  itotori wiki list --snapshot <ID>");
  lines.push("  itotori wiki edit --wiki-kind source-object --object-id <ID> \\");
  lines.push("    --candidate-json '{...}' --created-at <ISO>");
  lines.push(
    "  itotori localize --run-mode production --structure <structure.json> --bridge <bridge.json> --source-root <game-dir> --build-root <build-dir> --target-locale <locale> --output <run.json>",
  );
  lines.push(
    "  itotori localize-portfolio --portfolio <portfolio.json> [--output <portfolio-result.json>]",
  );
  lines.push("");

  lines.push("See docs/install.md for the full install path and");
  lines.push("    docs/security-and-limitations.md for the security posture.");

  return lines.join("\n");
}

/** Help for a concrete command. Keep the parsed flag surface next to the
 * top-level help so `itotori <command> --help` is useful at the failure point. */
export function buildCommandHelpText(args: readonly string[]): string | undefined {
  const command = args[0];
  const subcommand = args[1];
  const lines: string[] = [];
  const usage = (value: string) => {
    lines.push("USAGE:");
    lines.push(`  ${value}`);
    lines.push("");
  };

  switch (command) {
    case "init":
      usage("itotori init [--non-interactive] [--config <PATH>]");
      lines.push("Writes local setup configuration. Supply OpenRouter, database, and field-cipher");
      lines.push(
        "credentials through the environment or an env file; never put secrets on the command line.",
      );
      break;
    case "extract":
      usage("itotori extract --engine <ENGINE> ... --bundle-output <JSON>");
      lines.push("RealLive requires --engine reallive, --game-root, --game-id, --game-version,");
      lines.push("--source-profile-id, --source-locale, and exactly one scope (--scene, --scenes,");
      lines.push("--unit-range, or --whole-seen).");
      break;
    case "structure-export":
      usage("itotori structure-export --engine <ENGINE> --output <JSON> ...");
      lines.push(
        "RealLive requires --engine reallive --gameexe <INI> --seen <TXT> --output <JSON>.",
      );
      lines.push("--bridge <JSON>, --entry-scene <N>, and --max-scenes <N> are optional.");
      break;
    case "wiki":
      if (subcommand !== "build") return undefined;
      usage(
        "itotori wiki build --structure <JSON> --bridge <JSON> --source-locale <LOCALE> --run-mode <MODE> [--output <JSON>]",
      );
      lines.push(
        "MODE is production, pilot, or test-dev. Optional: --concurrency, --roles, --portrait-sources.",
      );
      break;
    case "localize":
      usage(
        "itotori localize --project-id <ID> --run-id <ID> --locale-branch-id <ID> --target-locale <LOCALE> --source-root <PATH> --build-root <PATH> --run-mode <MODE> --structure <JSON> --bridge <JSON> [--output <JSON>]",
      );
      lines.push(
        "Optional: --context-scope, --output-scope, --whole-scene-max-units, --ablation, --lease-owner-id.",
      );
      break;
    case "patch":
      if (subcommand === "produce") {
        usage(
          "itotori patch produce --input <JSON> --source <PATH> --build-root <PATH> --scope dialogue-only|dialogue+choices --output <JSON>",
        );
      } else {
        usage(
          "itotori patch --source <PATH> --target <PATH> --bundle <TRANSLATED-BRIDGE> --scope dialogue-only|dialogue+choices [--force]",
        );
      }
      break;
    case "validate":
      usage(
        "itotori validate --engine reallive --seen <TXT> --scene <N> --gameexe <INI> --game-dir <DIR> --replay-log <JSON> --artifact-root <DIR> --render-output <JSON>",
      );
      lines.push(
        "Optional: --redaction, --print-textlines, --source-seen, --bg-asset, --private-artifact-root,",
      );
      lines.push("--run-id, --expect-text-contains, --width, --height.");
      break;
    default:
      return undefined;
  }
  lines.push("");
  lines.push("Run `itotori --help` for the complete command list.");
  return lines.join("\n");
}

export const ITOTORI_HELP_TEXT = buildHelpText(false);
