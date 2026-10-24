// Reviewed against Drive Discovery revision 20261020. Resource keys, decryption JWTs,
// and vendor-generated private download destinations are permanently withheld.
import { safe, refuse, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
export const DRIVE_VALUE_SAFETY = {
  title: "Google Drive",
  embeddedUrls: {},
  operations: {
    "GET /changes": refuse(
      "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
    ),
    "GET /changes/startPageToken": refuse(
      "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
    ),
    "POST /changes/watch": refuse("Persistent watch delivery and channel administration are outside this connection."),
    "GET /drives": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "nextPageToken",
      ]),
    ),
    "GET /files": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "files[].appProperties",
        "nextPageToken",
      ]),
    ),
    "POST /files": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "appProperties",
      ]),
    ),
    "GET /files/generateCseToken": refuse(
      "Credential minting is outside this connection; no CSE access token is returned.",
    ),
    "GET /files/{fileId}": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "appProperties",
      ]),
    ),
    "PATCH /files/{fileId}": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "appProperties",
      ]),
    ),
    "GET /files/{fileId}/accessproposals": refuse(
      "Approval and access-proposal workflows require separate review and are outside this connection.",
    ),
    "GET /files/{fileId}/approvals": refuse(
      "Approval and access-proposal workflows require separate review and are outside this connection.",
    ),
    "POST /files/{fileId}/approvals/{approvalId}:reassign": refuse(
      "Approval and access-proposal workflows require separate review and are outside this connection.",
    ),
    "GET /files/{fileId}/comments": refuse(
      "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
    ),
    "GET /files/{fileId}/comments/{commentId}/replies": refuse(
      "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
    ),
    "POST /files/{fileId}/copy": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "appProperties",
      ]),
    ),
    "GET /files/{fileId}/listLabels": refuse(
      "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
    ),
    "GET /files/{fileId}/permissions": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "nextPageToken",
      ]),
    ),
    "PATCH /files/{fileId}/permissions/{permissionId}": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", []),
    ),
    "GET /files/{fileId}/revisions": vendorErrors(
      safe("File metadata and continuation tokens are requested data; private capabilities are withheld globally.", [
        "nextPageToken",
      ]),
    ),
    "POST /files/{fileId}/watch": refuse(
      "Persistent watch delivery and channel administration are outside this connection.",
    ),
    "GET /teamdrives": refuse(
      "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
    ),
  },
  fields: {
    nextPageToken: {
      verdict: "keep",
      reason: "Opaque continuation bound to the delegated grant, not an access credential.",
    },
    appProperties: {
      verdict: "keep",
      reason: "Private application-authored metadata, not a Google credential; nested values still cross safety.",
    },
    jwt: { verdict: "redact", reason: "Client encryption decryption credentials are never returnable." },
    resourceKey: { verdict: "redact", reason: "Link-sharing access keys convey private file access." },
    targetResourceKey: { verdict: "redact", reason: "Shortcut target access keys convey private file access." },
    webContentLink: {
      verdict: "redact",
      reason: "Use the bounded named content tool instead of a download destination.",
    },
    exportLinks: { verdict: "redact", reason: "Use the bounded named export instead of download destinations." },
    thumbnailLink: { verdict: "redact", reason: "Short-lived thumbnail URLs convey private content." },
    downloadUrl: { verdict: "redact", reason: "Revision download destinations are private media capabilities." },
  },
} as const satisfies ValueSafetyTable;

/** Resource-key URLs are private even when embedded in ordinary metadata text. */
export function withholdDriveLinks(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(/https?:\/\/[^\s<>"\x60]+/gi, (text) => {
      try {
        const url = new URL(text.replaceAll("&amp;", "&"));
        const names = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
        return names.some((key) => /^(?:target)?resourcekey$/i.test(key)) ? "[redacted]" : text;
      } catch {
        return text;
      }
    });
  if (Array.isArray(value)) return value.map(withholdDriveLinks);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withholdDriveLinks(item)]));
  return value;
}
