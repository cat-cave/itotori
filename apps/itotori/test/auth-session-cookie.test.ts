import { describe, expect, it } from "vitest";
import {
  itotoriSessionCookieName,
  parseItotoriSessionCookie,
  serializeItotoriSessionCookie,
  serializeItotoriSessionRevocationCookie,
} from "../src/auth-session-cookie.js";

describe("itotori auth session cookie helpers", () => {
  it("serializes opaque browser sessions as HttpOnly SameSite cookies", () => {
    const cookie = serializeItotoriSessionCookie({
      sessionId: "opaque/session token",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(cookie).toContain(`${itotoriSessionCookieName}=opaque%2Fsession%20token`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Expires=Sat, 01 Aug 2026 00:00:00 GMT");
  });

  it("parses only the itotori session cookie from a Cookie header", () => {
    expect(
      parseItotoriSessionCookie("theme=dark; itotori_session=opaque%2Fsession%20token; other=1"),
    ).toBe("opaque/session token");
    expect(parseItotoriSessionCookie("theme=dark")).toBeUndefined();
    expect(parseItotoriSessionCookie("itotori_session=%E0%A4%A")).toBeUndefined();
  });

  it("serializes immediate browser cookie revocation", () => {
    const cookie = serializeItotoriSessionRevocationCookie({ secure: false });

    expect(cookie).toContain(`${itotoriSessionCookieName}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cookie).not.toContain("Secure");
  });
});
