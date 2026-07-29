import { createHash } from "node:crypto";
import {
  DOMParser,
  XMLSerializer,
  type Document as XmldomDocument,
  type Element as XmldomElement,
  type Node as XmldomNode,
} from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import type { ExternalIdentityProviderClaim } from "../authorization.js";
import {
  assertNonEmpty,
  ItotoriSamlLoginAdapterError,
  type SamlAssertionResult,
  type SamlAssertionValidationInput,
  type SamlProtocolClient,
} from "./saml-login-adapter-contracts.js";

export class HttpPostSamlProtocolClient implements SamlProtocolClient {
  async validateLoginResponse(input: SamlAssertionValidationInput): Promise<SamlAssertionResult> {
    const xml = decodeSamlResponse(input.samlResponse);
    const doc = parseSamlXml(xml);
    assertSamlSuccess(doc);
    const assertionXml = verifySignedSamlAssertion(xml, doc, input.certificateFingerprint);
    const assertionDoc = parseSamlXml(assertionXml);
    assertIssuer(assertionDoc, input.idpEntityId);
    assertSamlBinding(doc, assertionDoc, input);
    assertAssertionTimeWindow(assertionDoc, input.now ?? new Date());
    const subject = readRequiredElementText(assertionDoc, "NameID", "SAML assertion subject");
    const email = readFirstAttributeValue(assertionDoc, [
      "email",
      "mail",
      "emailaddress",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      "urn:oid:0.9.2342.19200300.100.1.3",
    ]);
    const displayName =
      readFirstAttributeValue(assertionDoc, [
        "displayname",
        "name",
        "cn",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
        "urn:oid:2.5.4.3",
      ]) ??
      email ??
      subject;
    const result: SamlAssertionResult = {
      subject,
      displayName,
      providerClaims: providerClaimsFromSamlAttributes(assertionDoc),
    };
    if (email !== undefined) {
      result.email = email;
      result.emailVerified = true;
    }
    return result;
  }
}

function decodeSamlResponse(samlResponse: string): string {
  assertNonEmpty(samlResponse, "samlResponse");
  const trimmed = samlResponse.trim();
  if (trimmed.startsWith("<")) {
    return trimmed;
  }
  try {
    const xml = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (!xml.startsWith("<")) {
      throw new ItotoriSamlLoginAdapterError("decoded SAML response is not XML");
    }
    return xml;
  } catch (error) {
    if (error instanceof ItotoriSamlLoginAdapterError) {
      throw error;
    }
    throw new ItotoriSamlLoginAdapterError(
      `SAML response must be XML or base64-encoded XML: ${String(error)}`,
    );
  }
}

type SamlXmlSource = string | XmldomDocument | XmldomElement;

function parseSamlXml(xml: string): XmldomDocument {
  try {
    return new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") {
          throw new Error(message);
        }
      },
    }).parseFromString(xml, "text/xml");
  } catch (error) {
    throw new ItotoriSamlLoginAdapterError(`SAML response XML is invalid: ${String(error)}`);
  }
}

function verifySignedSamlAssertion(
  xml: string,
  doc: XmldomDocument,
  expectedFingerprint?: string,
): string {
  if (expectedFingerprint === undefined) {
    throw new ItotoriSamlLoginAdapterError("SAML signing certificate fingerprint is required");
  }
  const normalizedExpected = normalizeFingerprint(expectedFingerprint);
  const verifiedAssertions: string[] = [];
  for (const assertion of findElements(doc, "Assertion")) {
    const signature = findElements(assertion, "Signature").find(
      (element) => element.namespaceURI === "http://www.w3.org/2000/09/xmldsig#",
    );
    if (signature === undefined) {
      continue;
    }
    const certificate = readElementTexts(signature, "X509Certificate")[0];
    if (certificate === undefined) {
      throw new ItotoriSamlLoginAdapterError("SAML signing certificate is missing");
    }
    if (certificateFingerprint(certificate) !== normalizedExpected) {
      throw new ItotoriSamlLoginAdapterError("SAML signing certificate fingerprint mismatch");
    }
    const verifier = new SignedXml({
      publicCert: certificatePem(certificate),
      getCertFromKeyInfo: () => null,
    });
    verifier.loadSignature(signature as unknown as Node);
    let valid = false;
    try {
      valid = verifier.checkSignature(xml);
    } catch (error) {
      throw new ItotoriSamlLoginAdapterError(
        `SAML XML signature verification failed: ${String(error)}`,
      );
    }
    if (!valid) {
      throw new ItotoriSamlLoginAdapterError("SAML XML signature verification failed");
    }
    for (const signedReference of verifier.getSignedReferences()) {
      const signedDoc = parseSamlXml(signedReference);
      const signedRoot = requireDocumentElement(signedDoc, "signed SAML reference");
      if (localNameOf(signedRoot) === "Assertion") {
        verifiedAssertions.push(signedReference);
      }
    }
  }
  if (verifiedAssertions.length !== 1) {
    throw new ItotoriSamlLoginAdapterError(
      "SAML response must contain exactly one signed assertion",
    );
  }
  const verifiedAssertion = verifiedAssertions[0];
  if (verifiedAssertion === undefined) {
    throw new ItotoriSamlLoginAdapterError(
      "SAML response must contain exactly one signed assertion",
    );
  }
  return verifiedAssertion;
}

function assertSamlSuccess(xml: SamlXmlSource): void {
  const statusValue = readFirstElementAttribute(xml, "StatusCode", "Value");
  if (
    statusValue === undefined ||
    (statusValue !== "Success" && !statusValue.endsWith(":Success"))
  ) {
    throw new ItotoriSamlLoginAdapterError("SAML response status is not Success");
  }
}

function assertIssuer(xml: SamlXmlSource, expectedEntityId: string): void {
  const issuers = readElementTexts(xml, "Issuer");
  if (issuers.length === 0 || issuers.some((issuer) => issuer !== expectedEntityId)) {
    throw new ItotoriSamlLoginAdapterError(`SAML issuer mismatch: expected ${expectedEntityId}`);
  }
}

function assertSamlBinding(
  responseDoc: XmldomDocument,
  assertionDoc: XmldomDocument,
  input: SamlAssertionValidationInput,
): void {
  assertNonEmpty(input.requestId, "requestId");
  assertNonEmpty(input.spEntityId, "spEntityId");
  assertNonEmpty(input.acsUrl, "acsUrl");
  const response = requireDocumentElement(responseDoc, "SAML response");
  if (localNameOf(response) !== "Response") {
    throw new ItotoriSamlLoginAdapterError("SAML response root is not Response");
  }
  assertRequiredAttribute(response, "Destination", input.acsUrl, "SAML response Destination");
  assertRequiredAttribute(response, "InResponseTo", input.requestId, "SAML response InResponseTo");
  const audiences = readElementTexts(assertionDoc, "Audience");
  if (!audiences.includes(input.spEntityId)) {
    throw new ItotoriSamlLoginAdapterError("SAML assertion audience mismatch");
  }
  const confirmations = findElements(assertionDoc, "SubjectConfirmationData");
  if (
    !confirmations.some(
      (confirmation) =>
        confirmation.getAttribute("Recipient") === input.acsUrl &&
        confirmation.getAttribute("InResponseTo") === input.requestId,
    )
  ) {
    throw new ItotoriSamlLoginAdapterError("SAML assertion subject confirmation mismatch");
  }
}

function assertAssertionTimeWindow(xml: SamlXmlSource, now: Date): void {
  for (const tag of readStartTags(xml, "Conditions")) {
    const notBefore = readAttribute(tag, "NotBefore");
    if (notBefore !== undefined && now.getTime() < parseSamlInstant(notBefore).getTime()) {
      throw new ItotoriSamlLoginAdapterError("SAML assertion is not valid yet");
    }
    const notOnOrAfter = readAttribute(tag, "NotOnOrAfter");
    if (notOnOrAfter !== undefined && now.getTime() >= parseSamlInstant(notOnOrAfter).getTime()) {
      throw new ItotoriSamlLoginAdapterError("SAML assertion has expired");
    }
  }
}

function parseSamlInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ItotoriSamlLoginAdapterError(`SAML instant is invalid: ${value}`);
  }
  return parsed;
}

function providerClaimsFromSamlAttributes(xml: SamlXmlSource): ExternalIdentityProviderClaim[] {
  const claims: ExternalIdentityProviderClaim[] = [];
  const seen = new Set<string>();
  for (const attribute of readSamlAttributes(xml)) {
    const key = normalizeAttributeName(attribute.name);
    if (key === "group" || key === "groups" || key === "memberof") {
      appendClaimValues(claims, seen, "group", attribute.values);
    } else if (key === "role" || key === "roles") {
      appendClaimValues(claims, seen, "role", attribute.values);
    } else if (key === "scope" || key === "scopes") {
      appendClaimValues(
        claims,
        seen,
        "scope",
        attribute.values.flatMap((value) => value.split(/\s+/u)),
      );
    }
  }
  return claims;
}

function appendClaimValues(
  claims: ExternalIdentityProviderClaim[],
  seen: Set<string>,
  kind: ExternalIdentityProviderClaim["kind"],
  values: readonly string[],
): void {
  for (const value of values.map((item) => item.trim()).filter((item) => item.length > 0)) {
    const key = `${kind}\0${value}`;
    if (seen.has(key)) {
      continue;
    }
    claims.push({ kind, value });
    seen.add(key);
  }
}

function readFirstAttributeValue(xml: SamlXmlSource, names: readonly string[]): string | undefined {
  const normalizedNames = new Set(names.map(normalizeAttributeName));
  for (const attribute of readSamlAttributes(xml)) {
    if (normalizedNames.has(normalizeAttributeName(attribute.name))) {
      return attribute.values[0];
    }
  }
  return undefined;
}

function readSamlAttributes(source: SamlXmlSource): { name: string; values: string[] }[] {
  const xml = xmlSource(source);
  const attributes: { name: string; values: string[] }[] = [];
  const attributePattern =
    /<([A-Za-z_][\w.-]*:)?Attribute\b([^>]*)>([\s\S]*?)<\/([A-Za-z_][\w.-]*:)?Attribute>/gu;
  for (const match of xml.matchAll(attributePattern)) {
    const rawName =
      readAttribute(match[2] ?? "", "Name") ?? readAttribute(match[2] ?? "", "FriendlyName");
    if (rawName === undefined) {
      continue;
    }
    const values = readElementTexts(match[3] ?? "", "AttributeValue");
    attributes.push({ name: rawName, values });
  }
  return attributes;
}

function readRequiredElementText(xml: SamlXmlSource, localName: string, label: string): string {
  const value = readElementTexts(xml, localName)[0];
  if (value === undefined) {
    throw new ItotoriSamlLoginAdapterError(`${label} is missing`);
  }
  return value;
}

function readElementTexts(source: SamlXmlSource, localName: string): string[] {
  const xml = xmlSource(source);
  const pattern = new RegExp(
    `<([A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}\\b[^>]*>([\\s\\S]*?)<\\/([A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}>`,
    "gu",
  );
  return [...xml.matchAll(pattern)]
    .map((match) => xmlUnescape(stripXmlTags(match[2] ?? "").trim()))
    .filter((value) => value.length > 0);
}

function readFirstElementAttribute(
  xml: SamlXmlSource,
  localName: string,
  attributeName: string,
): string | undefined {
  const tag = readStartTags(xml, localName)[0];
  return tag === undefined ? undefined : readAttribute(tag, attributeName);
}

function readStartTags(source: SamlXmlSource, localName: string): string[] {
  const xml = xmlSource(source);
  const pattern = new RegExp(`<([A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}\\b([^>]*)>`, "gu");
  return [...xml.matchAll(pattern)].map((match) => match[2] ?? "");
}

function readAttribute(tagAttributes: string, attributeName: string): string | undefined {
  const pattern = new RegExp(
    `\\b${escapeRegExp(attributeName)}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "u",
  );
  const match = pattern.exec(tagAttributes);
  return match === null ? undefined : xmlUnescape(match[2] ?? match[3] ?? "");
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]*>/gu, "");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function normalizeAttributeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/gu, "");
}

function normalizeFingerprint(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-f0-9]/gu, "");
  if (normalized.length === 0) {
    throw new ItotoriSamlLoginAdapterError("SAML certificate fingerprint must be non-empty");
  }
  return normalized;
}

function certificateFingerprint(certificate: string): string {
  const der = Buffer.from(certificate.replace(/\s+/gu, ""), "base64");
  return createHash("sha256").update(der).digest("hex");
}

function certificatePem(certificate: string): string {
  const compact = certificate.replace(/\s+/gu, "");
  const lines = compact.match(/.{1,64}/gu) ?? [compact];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

function assertRequiredAttribute(
  element: XmldomElement,
  attributeName: string,
  expected: string,
  label: string,
): void {
  const actual = element.getAttribute(attributeName);
  if (actual !== expected) {
    throw new ItotoriSamlLoginAdapterError(`${label} mismatch`);
  }
}

function findElements(root: XmldomDocument | XmldomElement, localName: string): XmldomElement[] {
  const elements = Array.from(root.getElementsByTagName("*"));
  return elements.filter((element) => localNameOf(element) === localName);
}

function localNameOf(element: XmldomElement): string {
  return element.localName ?? element.nodeName.replace(/^.*:/u, "");
}

function requireDocumentElement(doc: XmldomDocument, label: string): XmldomElement {
  const element = doc.documentElement;
  if (element === null) {
    throw new ItotoriSamlLoginAdapterError(`${label} XML document is empty`);
  }
  return element;
}

function xmlSource(source: SamlXmlSource): string {
  return typeof source === "string"
    ? source
    : new XMLSerializer().serializeToString(source as XmldomNode);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
