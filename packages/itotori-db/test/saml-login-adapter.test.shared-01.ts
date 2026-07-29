import { createHash } from "node:crypto";

import { SignedXml } from "xml-crypto";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  defaultLocalAccountId,
  localUserId,
} from "../src/authorization.js";

import { ItotoriAuthSsoSettingsRepository } from "../src/repositories/auth-sso-settings-repository.js";

export async function configureMockSamlProvider(db: ItotoriDatabase, providerId: string) {
  await bootstrapLocalUser(db);
  await bootstrapDefaultAccountPrincipal(db);
  const ssoSettings = new ItotoriAuthSsoSettingsRepository(db);
  await ssoSettings.configureSettings(
    { userId: localUserId },
    {
      accountId: defaultLocalAccountId,
      provider: {
        protocol: "saml",
        providerId,
        displayName: "Mock SAML",
        enabled: true,
        ssoUrl: "https://idp.example.test/saml/sso",
        entityId: "https://idp.example.test/saml/metadata",
        certificateFingerprint: testSamlCertificateFingerprint(),
      },
      security: {
        requireSso: true,
        requireMfa: false,
        allowPasswordLogin: false,
      },
      sessionPolicy: {
        idleTimeoutMinutes: 30,
        absoluteTimeoutMinutes: 120,
      },
    },
  );
}

export function mockSamlResponse(input: {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  groups: string[];
  requestId: string;
  spEntityId: string;
  acsUrl: string;
  notBefore: string;
  notOnOrAfter: string;
  signed?: boolean;
}): string {
  const groupAttributes = input.groups
    .map(
      (group) => `
        <saml:AttributeValue>${escapeXml(group)}</saml:AttributeValue>`,
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="response-${escapeXml(input.requestId)}"
  Version="2.0"
  IssueInstant="${input.notBefore}"
  Destination="${escapeXml(input.acsUrl)}"
  InResponseTo="${escapeXml(input.requestId)}">
  <saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
  <saml:Assertion ID="assertion-${escapeXml(input.requestId)}" Version="2.0" IssueInstant="${input.notBefore}">
    <saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>
    <saml:Subject>
      <saml:NameID>${escapeXml(input.subject)}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData
          Recipient="${escapeXml(input.acsUrl)}"
          InResponseTo="${escapeXml(input.requestId)}"
          NotOnOrAfter="${input.notOnOrAfter}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${input.notBefore}" NotOnOrAfter="${input.notOnOrAfter}">
      <saml:AudienceRestriction>
        <saml:Audience>${escapeXml(input.spEntityId)}</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>
      <saml:Attribute Name="email">
        <saml:AttributeValue>${escapeXml(input.email)}</saml:AttributeValue>
      </saml:Attribute>
      <saml:Attribute Name="displayName">
        <saml:AttributeValue>${escapeXml(input.displayName)}</saml:AttributeValue>
      </saml:Attribute>
      <saml:Attribute Name="groups">${groupAttributes}
      </saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;
  const responseXml =
    input.signed === false ? xml : signSamlAssertion(xml, `assertion-${input.requestId}`);
  return Buffer.from(responseXml, "utf8").toString("base64");
}

export function signSamlAssertion(xml: string, assertionId: string): string {
  const signer = new SignedXml({
    idAttribute: "ID",
    privateKey: TEST_SAML_PRIVATE_KEY,
    publicCert: TEST_SAML_CERTIFICATE,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    getKeyInfoContent: SignedXml.getKeyInfoContent,
  });
  signer.addReference({
    xpath: `//*[@ID="${assertionId}"]`,
    uri: `#${assertionId}`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: {
      reference: `//*[@ID="${assertionId}"]/*[local-name(.)="Issuer"]`,
      action: "after",
    },
  });
  return signer.getSignedXml();
}

export function testSamlCertificateFingerprint(): string {
  return createHash("sha256").update(samlCertificateDer(TEST_SAML_CERTIFICATE)).digest("hex");
}

export function samlCertificateDer(certificate: string): Buffer {
  return Buffer.from(
    certificate
      .replace(/-----BEGIN CERTIFICATE-----/gu, "")
      .replace(/-----END CERTIFICATE-----/gu, "")
      .replace(/\s+/gu, ""),
    "base64",
  );
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export const TEST_SAML_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC5V3AVoVnLFo5h
cEKztlr1V3irmjua8ss/ui4PrsNKA8ZwGTBUUOY88EFLePdPasysBUFUG0WVK/BX
iVOVbe1CXMRChc0B0kbAGpC7HnfOR7L1y73VAc4WjVC1TXLfBM/kiHJK3/Rkvcj0
tWBYN36bNs3P3Oa+Z/X4mllWjp4kMxFLcBG0ayUbe5ChuIc7yG1iBkkQLW4Ou8Va
KBOG3Wl3o+IPIhrGWPvedJed4zHzQ+pylbGGgAOn8cBkf5tfph6XKTrfnHazPAEJ
e3KmKnscA0RNjCNwLpp9SSzwB8FG4VLB7VmSzLr/Y8LELxQPihznsaEAkqOhFYRa
kyLZ3tIXAgMBAAECggEANvhZfHjaBnN+sCSZC+8aZCjY1+CLLCY1pQWFss4NCs86
1DWMUX2bA9joLMfIZewRnzWBzj22cgtRoczPlwK++09DQE2p44/nvwNCCNV9CBfY
2rDecSYzZxnrpZI+byngtPHJIC7zL8vgJcADvrZa3RMwkKV+ZFu2JtE0jQkIm0hu
5heo5xnpSAqldjy2q2R/ZWphRUwMgRxatZxq+usDnF+7EEReyF0nwGBcp62cca0q
r9Yn/N0tSSS3AvLSF3n0okrb53cGYesneVmbRbeuwLvflBfy/CCXM98zS6oxfa4Z
hyFg4+iW8juz7tLS52fDMKfZJBRtWtRpsarZKQhltQKBgQDgFzbYLoPPXIluxV8M
BdOcXPEqoa+zEC0Rob71K9LaDVKoSGLyoykO6WrrpG1rYu234mS4B3HRYJ77K1Qv
XcfJTrx3tm/7OJAOWIPQEFQYz4bT+2n4nM17xcKnmEzwElIRHR0E7Pv1C5qCQyXR
iEQkJr2zHB204B4uXAttMaitXQKBgQDTu7NEuJerK3pEq/PYrgkP7EQK6SSdjL9D
g/N/u7gB9bweHKbRM/lGAIBKbV6RWE7sM0NNtSuoGoEfJGbukX3EJEJMX2CnAhbk
qiuanOkZewq29EfcKGS3vpYKPZYs0FaOFqWeZEXwb5D8WnaVoyclI5yofek3EbQx
XBQ70AFSAwKBgQCgXXyOMJt7ZcmkT/K48+J/37Nmwtat2kGmgI3bfkUibq5cZ5EH
+uODHF+7yqvTUbS1B3r0h79YC0E6lcNlMkOrOIF/WjvBGLVeztFlsIm+R6VBRoaL
uAsFLH0k2sUUeMfqH1+JCt80ed1UoyEJVe8Nv/u5lcFck5aFrrEur376sQKBgQCl
Zq+4M2tn7+Ln2lv3HJ0/rxXIYDCWUujm2SFS21X3UfvOmhtGug80vBd8DMwfRpkA
s1sUTT75ZxsPNOSj4UwZ+SlBeBCM5njz0GuXsJP3r8LDATlRpsxnLZ8QCORTxbyX
6uEeRr7MAJuGRzTz2CwwOw2aIiIZPt9A3+l+gBNH+QKBgQCk74+2jpfll+oWwMuP
G0beqRgYtw4QGQ1ygGGoRvu9BGSWiwjMg0vVqurqjWyCEXr9AQvJ5u6Hv1+5/3+I
gMwo0FoVzdbEU2CmWuXEJRBxHxl74TVQCgkP4jQWpurqlL8VRPb06/8Nkq/J9pX6
oa27pHhyzWfakbgsUC6BzF1kEw==
-----END PRIVATE KEY-----`;

export const TEST_SAML_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUTrWYDky1EvPJgy/D9qoAtJpklPwwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRaXRvdG9yaS1zYW1sLXRlc3QwHhcNMjYwNzA5MTA1NDQ3
WhcNMzYwNzA2MTA1NDQ3WjAcMRowGAYDVQQDDBFpdG90b3JpLXNhbWwtdGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALlXcBWhWcsWjmFwQrO2WvVX
eKuaO5ryyz+6Lg+uw0oDxnAZMFRQ5jzwQUt4909qzKwFQVQbRZUr8FeJU5Vt7UJc
xEKFzQHSRsAakLsed85HsvXLvdUBzhaNULVNct8Ez+SIckrf9GS9yPS1YFg3fps2
zc/c5r5n9fiaWVaOniQzEUtwEbRrJRt7kKG4hzvIbWIGSRAtbg67xVooE4bdaXej
4g8iGsZY+950l53jMfND6nKVsYaAA6fxwGR/m1+mHpcpOt+cdrM8AQl7cqYqexwD
RE2MI3Aumn1JLPAHwUbhUsHtWZLMuv9jwsQvFA+KHOexoQCSo6EVhFqTItne0hcC
AwEAAaNTMFEwHQYDVR0OBBYEFBOMQheMvvi89iAqEmiNTsQ+OwqzMB8GA1UdIwQY
MBaAFBOMQheMvvi89iAqEmiNTsQ+OwqzMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAKBYRqVjMbi/+SgJ0xbVx2xLGyijb0cjoX2RezuHI1jIepZs
eIJ44AeKtHOfDfdYQ1qgLXrpGmNPzLuU/X4EA4bGeRFMeugLhtsdHoTfdcpOr7ZL
G+Ia5lJ97EX06J7yGlNL5694IO7gf3NtaNRFtwG87qQfS3Sf69BYifbKZyAK3+Se
kckVwODY0NEDvtpc1j0kBnqjH69HN4SWkmYXRVuSZpDiulgk4z2U8ho9O5wtHHvL
ky/Rk6Ag46Mxpby6CyXhrWjWhfeKqKni62YanI3yfn9cOc7He9yQD+HRa39lShWo
9xDZ28rpvJzu6pFuL9/N4/gxVz8d/KfIClqkJSY=
-----END CERTIFICATE-----`;
