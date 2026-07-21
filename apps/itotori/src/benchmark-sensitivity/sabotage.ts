// Sabotage injector for §9 sensitivity (meta-validity).
//
// Degrades a clean translation by injecting taxonomy-aligned seeded defects so
// the instrument can be tested for sensitivity. Pure + order-stable.
//
// DETECTOR DEPENDENCE (honesty — see methodology §9 sensitivity honesty):
//   - `untranslated_residue` / `layout_overflow` trip REAL deterministic §3
//     metrics (residue scan + wrap-compliance). These carry judge-INDEPENDENT
//     sensitivity weight.
//   - `meaning_shift` / `voice_drift` only stamp human-readable markers. There
//     is no deterministic metric for inverted propositions or register drift;
//     a fixture qualityScoreFn that keys on SABOTAGE_*_MARKER is a test double
//     for the LLM judge. Fixture-only sensitivity runs that rely on that
//     double are JUDGE-SCRIPTED and must not be overclaimed as metric-caught.

export class BenchmarkSensitivityError extends Error {
  constructor(detail: string) {
    super(`benchmark-sensitivity refused: ${detail}`);
    this.name = "BenchmarkSensitivityError";
  }
}

/**
 * Seeded-defect kinds the injector can apply.
 * Names align with the retired meta-validity harness and methodology §3/§9
 * (taxonomy uses `speaker_voice_drift` for the voice seed; we accept both).
 */
export const SABOTAGE_DEFECT_KINDS = [
  "meaning_shift",
  "voice_drift",
  "layout_overflow",
  "untranslated_residue",
] as const;
export type SabotageDefectKind = (typeof SABOTAGE_DEFECT_KINDS)[number];

/**
 * Stable markers stamped by meaning/voice sabotage. Exported so a scripted
 * fixture judge can recognize them — a real LLM judge would read the broken
 * register/proposition directly. NOT detected by the metric-caught path.
 */
export const SABOTAGE_REGISTER_MARKER = "[[FORMAL-DIRECTIVE]]";
export const SABOTAGE_MEANING_MARKER = "[[NEGATED]]";

/** Default residual source-script string (trips the §3 residue metric). */
export const DEFAULT_RESIDUE_MARKER = "（未翻訳）";

export type SabotageConfig = {
  kinds: readonly SabotageDefectKind[];
  residueMarker?: string;
};

/**
 * Deterministically degrade one translated line. Pure.
 * Residue/overflow sabotage produces text a REAL deterministic metric must
 * fail; meaning/voice sabotage is only for judge-scripted fixture paths.
 */
export function sabotageTranslation(text: string, config: SabotageConfig): string {
  if (config.kinds.length === 0) {
    throw new BenchmarkSensitivityError("sabotage requires at least one defect kind");
  }
  for (const kind of config.kinds) {
    if (!(SABOTAGE_DEFECT_KINDS as readonly string[]).includes(kind)) {
      throw new BenchmarkSensitivityError(`unknown sabotage kind '${kind}'`);
    }
  }
  const residueMarker = config.residueMarker ?? DEFAULT_RESIDUE_MARKER;
  const kinds = new Set(config.kinds);
  let out = text;

  if (kinds.has("meaning_shift")) {
    // Invert the proposition — judge/human only (no deterministic metric).
    out = `${SABOTAGE_MEANING_MARKER} On the contrary, ${out}`;
  }
  if (kinds.has("voice_drift")) {
    // Force a stiff, out-of-character formal register — judge/human only.
    out = `${SABOTAGE_REGISTER_MARKER} I hereby formally state: ${out}`;
  }
  if (kinds.has("untranslated_residue")) {
    // Residual untranslated source script — trips §3 residue metric.
    out = `${out} ${residueMarker}`;
  }
  if (kinds.has("layout_overflow")) {
    // Blow past any reasonable text-box bound — trips §3 wrap-compliance.
    out = `${out} ${out} ${out} ${out} ${out}`;
  }
  return out;
}
