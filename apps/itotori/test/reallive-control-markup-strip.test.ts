// Unit coverage for the RealLive control-markup bridge contract: the
// translation→patchback bridge strips the KAIFUU-210 producer's OUT-OF-BAND
// control markup (`<reallive.kidoku …>`) from the translated body (the model
// reproduces every protected span inline), and conditionally bracket-wraps so
// a Shift-JIS-leading body — e.g. a `【話者】` name marker re-emitted as the
// leading body bytes — is never double-wrapped. The kidoku control bytes are
// re-emitted byte-identical by the kaifuu-reallive patchback from the
// untouched bytecode, so they must never appear in `target.text`.

import { describe, expect, it } from "vitest";

import {
  bracketWrapForRealLive,
  stripOutOfBandControlMarkup,
} from "../src/orchestrator/localize-project-stage-command.js";

describe("stripOutOfBandControlMarkup", () => {
  it("removes a single kidoku marker, keeping the in-body name token + prose", () => {
    expect(stripOutOfBandControlMarkup("<reallive.kidoku 1>【和人】「hello」")).toBe(
      "【和人】「hello」",
    );
  });

  it("removes the synthesised table-form kidoku marker", () => {
    expect(stripOutOfBandControlMarkup("<reallive.kidoku table:1>narration")).toBe("narration");
  });

  it("removes multiple markers (Kanon double-kidoku dialogue)", () => {
    expect(stripOutOfBandControlMarkup("<reallive.kidoku 26><reallive.kidoku 27>「x」")).toBe(
      "「x」",
    );
  });

  it("leaves prose without markup verbatim", () => {
    expect(stripOutOfBandControlMarkup("「plain line」")).toBe("「plain line」");
  });

  it("never truncates on an unterminated marker", () => {
    expect(stripOutOfBandControlMarkup("<reallive.kidoku 1")).toBe("<reallive.kidoku 1");
  });
});

describe("bracketWrapForRealLive", () => {
  it("wraps an ASCII-leading body so it lexes as a Textout run", () => {
    expect(bracketWrapForRealLive("[EN] good morning")).toBe("「[EN] good morning」");
  });

  it("does NOT double-wrap a name-marker-leading body (name stays the leading bytes)", () => {
    expect(bracketWrapForRealLive("【和人】「Whew」")).toBe("【和人】「Whew」");
  });

  it("does NOT double-wrap an already-quoted full-width body", () => {
    expect(bracketWrapForRealLive("「Whew」")).toBe("「Whew」");
  });
});

describe("bridge contract: strip then wrap", () => {
  it("produces a Textout body carrying no out-of-band control markup", () => {
    // A model draft that reproduces the kidoku + name protected spans inline.
    const draft = "<reallive.kidoku 3>【和人】「Whew, what a nice morning」";
    const body = bracketWrapForRealLive(stripOutOfBandControlMarkup(draft));
    expect(body).not.toContain("<reallive.kidoku");
    // Name marker preserved as the leading body bytes; not double-wrapped.
    expect(body).toBe("【和人】「Whew, what a nice morning」");
  });

  it("wraps a narration line (no name marker) after stripping the kidoku marker", () => {
    const draft = "<reallive.kidoku 2>I spread my arms in the middle of the garden.";
    const body = bracketWrapForRealLive(stripOutOfBandControlMarkup(draft));
    expect(body).not.toContain("<reallive.kidoku");
    expect(body).toBe("「I spread my arms in the middle of the garden.」");
  });
});
