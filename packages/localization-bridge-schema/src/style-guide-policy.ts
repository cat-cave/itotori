/**
 * Canonical policy payload consumed by localization runs. This describes the
 * active branch policy itself; it carries no conversation, proposal, or human
 * decision state.
 */
export const STYLE_GUIDE_POLICY_SCHEMA_VERSION = "style-guide-policy.v0" as const;

export const STYLE_GUIDE_POLICY_SECTIONS = [
  "tone",
  "terminology",
  "honorifics",
  "formatting",
  "protectedSpans",
] as const;

export type StyleGuidePolicySection = (typeof STYLE_GUIDE_POLICY_SECTIONS)[number];

export type StyleGuidePolicyRuleDraft = {
  ruleId: string;
  guidance: string;
};

export type StyleGuidePolicyV0Draft = {
  schemaVersion: typeof STYLE_GUIDE_POLICY_SCHEMA_VERSION;
  sections: Record<StyleGuidePolicySection, StyleGuidePolicyRuleDraft[]>;
};
