export const itotoriSessionCookieName = "itotori_session";

export type SerializeSessionCookieInput = {
  sessionId: string;
  expiresAt: Date;
  secure?: boolean;
};

export function serializeItotoriSessionCookie(input: SerializeSessionCookieInput): string {
  return [
    `${itotoriSessionCookieName}=${encodeURIComponent(input.sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${input.expiresAt.toUTCString()}`,
    ...(input.secure === false ? [] : ["Secure"]),
  ].join("; ");
}

export function serializeItotoriSessionRevocationCookie(
  options: { secure?: boolean } = {},
): string {
  return [
    `${itotoriSessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...(options.secure === false ? [] : ["Secure"]),
  ].join("; ");
}

export function parseItotoriSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader.trim() === "") {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== itotoriSessionCookieName) {
      continue;
    }
    const rawValue = rawValueParts.join("=");
    if (rawValue === "") {
      return undefined;
    }
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
