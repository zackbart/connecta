// Full frozen inventory; every callable method has a literal reviewed verdict.
import { googlePageToken } from "../../../http/hatch-paging.js";
import { googleHatchBinding } from "../../_shared/google/hatch.js";
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import type { Connection } from "../../../http/vendor.js";
import type { RestCall } from "../../_shared/rest/tools.js";
import { openapi } from "../openapi.generated.js";

export const driveIndex = new OperationIndex(openapi, {
  vendor: "drive",
  title: "Google Drive",
  pathMatching: "uri-template",
});
export const DRIVE_REFUSALS: Readonly<Record<string, string>> = {
  "GET /apps":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "GET /apps/{appId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "GET /changes":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "GET /changes/startPageToken":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "POST /changes/watch": "Persistent watch delivery and channel administration are outside this connection.",
  "POST /channels/stop": "Persistent watch delivery and channel administration are outside this connection.",
  "POST /drives":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "DELETE /drives/{driveId}":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "GET /drives/{driveId}":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "PATCH /drives/{driveId}":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "POST /drives/{driveId}/hide":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "POST /drives/{driveId}/unhide":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "GET /files/generateCseToken": "Credential minting is outside this connection; no CSE access token is returned.",
  "GET /files/generateIds":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "DELETE /files/trash": "Permanent deletion is outside this connection; use trash_file for recoverable trash.",
  "DELETE /files/{fileId}": "Permanent deletion is outside this connection; use trash_file for recoverable trash.",
  "GET /files/{fileId}/accessproposals":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "GET /files/{fileId}/accessproposals/{proposalId}":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/accessproposals/{proposalId}:resolve":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "GET /files/{fileId}/approvals":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "GET /files/{fileId}/approvals/{approvalId}":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/approvals/{approvalId}:approve":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/approvals/{approvalId}:cancel":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/approvals/{approvalId}:comment":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/approvals/{approvalId}:decline":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/approvals/{approvalId}:reassign":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "POST /files/{fileId}/approvals:start":
    "Approval and access-proposal workflows require separate review and are outside this connection.",
  "GET /files/{fileId}/comments":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "POST /files/{fileId}/comments":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "DELETE /files/{fileId}/comments/{commentId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "GET /files/{fileId}/comments/{commentId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "PATCH /files/{fileId}/comments/{commentId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "GET /files/{fileId}/comments/{commentId}/replies":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "POST /files/{fileId}/comments/{commentId}/replies":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "DELETE /files/{fileId}/comments/{commentId}/replies/{replyId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "GET /files/{fileId}/comments/{commentId}/replies/{replyId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "PATCH /files/{fileId}/comments/{commentId}/replies/{replyId}":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "POST /files/{fileId}/download":
    "Media transport and private download destinations are outside the hatch; use get_file_content for bounded safe content.",
  "GET /files/{fileId}/export":
    "Media transport and private download destinations are outside the hatch; use get_file_content for bounded safe content.",
  "GET /files/{fileId}/listLabels":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "POST /files/{fileId}/modifyLabels":
    "This operation has not been admitted to the narrow Drive execution allowlist; use the named file and permission workflows.",
  "POST /files/{fileId}/permissions":
    "Use share_file for every grant; it validates the grantee and defaults notification email to false. The pinned Discovery marks emailAddress and domain output-only.",
  "DELETE /files/{fileId}/revisions/{revisionId}":
    "Revision mutations can remove retained content or change publication; only revision metadata reads are admitted.",
  "PATCH /files/{fileId}/revisions/{revisionId}":
    "Revision mutations can remove retained content or change publication; only revision metadata reads are admitted.",
  "POST /files/{fileId}/watch": "Persistent watch delivery and channel administration are outside this connection.",
  "GET /operations/{name}":
    "Media transport and private download destinations are outside the hatch; use get_file_content for bounded safe content.",
  "GET /teamdrives":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "POST /teamdrives":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "DELETE /teamdrives/{teamDriveId}":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "GET /teamdrives/{teamDriveId}":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
  "PATCH /teamdrives/{teamDriveId}":
    "Shared-drive administration and ownership changes are outside this connection; list_shared_drives reads membership.",
};
const ROLES = ["reader", "commenter", "writer", "fileOrganizer", "organizer"];
function guard(call: RestCall): string | undefined {
  const refused = DRIVE_REFUSALS[`${call.method} ${call.op.path}`];
  if (refused) return refused;
  for (const name of ["transferOwnership", "moveToNewOwnersRoot", "useDomainAdminAccess", "enforceSingleParent"])
    if (Object.hasOwn(call.query, name))
      return `${name} is outside the Drive hatch; ownership and administrator authority cannot be changed.`;
  if (call.method === "GET" || call.method === "DELETE") return undefined;
  const body =
    call.body && typeof call.body === "object" && !Array.isArray(call.body)
      ? (call.body as Record<string, unknown>)
      : {};
  if (call.op.path.endsWith("/permissions/{permissionId}")) {
    if (Object.keys(body).some((key) => !["role", "allowFileDiscovery", "expirationTime"].includes(key)))
      return "Only role, allowFileDiscovery and expirationTime may change; use update_permission for the named workflow.";
    if (body["role"] !== undefined && !ROLES.includes(String(body["role"])))
      return "Ownership and pending ownership are never granted; choose a non-owner permission role.";
    if (!Object.keys(body).length && call.query["removeExpiration"] !== true)
      return "Pass a reviewed permission change; an empty update is not sent.";
  } else {
    if (
      body["parents"] !== undefined &&
      (!Array.isArray(body["parents"]) ||
        body["parents"].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)))
    )
      return "File parents must be original Drive ids or root, never withheld or altered values.";
    if (
      body["mimeType"] !== undefined &&
      (typeof body["mimeType"] !== "string" || !/^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(body["mimeType"]))
    )
      return "mimeType must be an original bare media type, never a withheld or altered value.";
    if (
      Object.keys(body).some(
        (key) =>
          !["name", "description", "mimeType", "parents", "trashed", "starred", "properties", "appProperties"].includes(
            key,
          ),
      )
    )
      return "Only reviewed file metadata may change; use create_file or update_file_content for media and share_file for grants.";
  }
  return undefined;
}
export function driveBinding(connection: Connection) {
  return googleHatchBinding(connection, {
    index: driveIndex,
    review:
      "Thirteen reviewed JSON metadata methods on the confined delegated Drive connection; grants remain named-only, with no permanent deletion, ownership transfer, media, watches or credential minting.",
    refusal: (op) => DRIVE_REFUSALS[`${op.method} ${op.path}`],
    refuse: guard,
  });
}
export const DRIVE_HATCH = {
  name: "drive",
  title: "Google Drive",
  index: driveIndex,
  pathExample: "/files/file_123",
  verdicts: {
    "GET /about": "read",
    "GET /apps": "refuse",
    "GET /apps/{appId}": "refuse",
    "GET /changes": "refuse",
    "GET /changes/startPageToken": "refuse",
    "POST /changes/watch": "refuse",
    "POST /channels/stop": "refuse",
    "GET /drives": "read",
    "POST /drives": "refuse",
    "DELETE /drives/{driveId}": "refuse",
    "GET /drives/{driveId}": "refuse",
    "PATCH /drives/{driveId}": "refuse",
    "POST /drives/{driveId}/hide": "refuse",
    "POST /drives/{driveId}/unhide": "refuse",
    "GET /files": "read",
    "POST /files": "destructive",
    "GET /files/generateCseToken": "refuse",
    "GET /files/generateIds": "refuse",
    "DELETE /files/trash": "refuse",
    "DELETE /files/{fileId}": "refuse",
    "GET /files/{fileId}": "read",
    "PATCH /files/{fileId}": "destructive",
    "GET /files/{fileId}/accessproposals": "refuse",
    "GET /files/{fileId}/accessproposals/{proposalId}": "refuse",
    "POST /files/{fileId}/accessproposals/{proposalId}:resolve": "refuse",
    "GET /files/{fileId}/approvals": "refuse",
    "GET /files/{fileId}/approvals/{approvalId}": "refuse",
    "POST /files/{fileId}/approvals/{approvalId}:approve": "refuse",
    "POST /files/{fileId}/approvals/{approvalId}:cancel": "refuse",
    "POST /files/{fileId}/approvals/{approvalId}:comment": "refuse",
    "POST /files/{fileId}/approvals/{approvalId}:decline": "refuse",
    "POST /files/{fileId}/approvals/{approvalId}:reassign": "refuse",
    "POST /files/{fileId}/approvals:start": "refuse",
    "GET /files/{fileId}/comments": "refuse",
    "POST /files/{fileId}/comments": "refuse",
    "DELETE /files/{fileId}/comments/{commentId}": "refuse",
    "GET /files/{fileId}/comments/{commentId}": "refuse",
    "PATCH /files/{fileId}/comments/{commentId}": "refuse",
    "GET /files/{fileId}/comments/{commentId}/replies": "refuse",
    "POST /files/{fileId}/comments/{commentId}/replies": "refuse",
    "DELETE /files/{fileId}/comments/{commentId}/replies/{replyId}": "refuse",
    "GET /files/{fileId}/comments/{commentId}/replies/{replyId}": "refuse",
    "PATCH /files/{fileId}/comments/{commentId}/replies/{replyId}": "refuse",
    "POST /files/{fileId}/copy": "destructive",
    "POST /files/{fileId}/download": "refuse",
    "GET /files/{fileId}/export": "refuse",
    "GET /files/{fileId}/listLabels": "refuse",
    "POST /files/{fileId}/modifyLabels": "refuse",
    "GET /files/{fileId}/permissions": "read",
    "POST /files/{fileId}/permissions": "refuse",
    "DELETE /files/{fileId}/permissions/{permissionId}": "destructive",
    "GET /files/{fileId}/permissions/{permissionId}": "read",
    "PATCH /files/{fileId}/permissions/{permissionId}": "destructive",
    "GET /files/{fileId}/revisions": "read",
    "DELETE /files/{fileId}/revisions/{revisionId}": "refuse",
    "GET /files/{fileId}/revisions/{revisionId}": "read",
    "PATCH /files/{fileId}/revisions/{revisionId}": "refuse",
    "POST /files/{fileId}/watch": "refuse",
    "GET /operations/{name}": "refuse",
    "GET /teamdrives": "refuse",
    "POST /teamdrives": "refuse",
    "DELETE /teamdrives/{teamDriveId}": "refuse",
    "GET /teamdrives/{teamDriveId}": "refuse",
    "PATCH /teamdrives/{teamDriveId}": "refuse",
  },
  named: {
    "GET /files": "search_files",
    "GET /files/{fileId}": "get_file",
    "POST /files": "create_file",
    "PATCH /files/{fileId}": "update_file",
    "POST /files/{fileId}/copy": "copy_file",
    "GET /files/{fileId}/export": "get_file_content",
    "GET /files/{fileId}/permissions": "list_permissions",
    "POST /files/{fileId}/permissions": "share_file",
    "PATCH /files/{fileId}/permissions/{permissionId}": "update_permission",
    "DELETE /files/{fileId}/permissions/{permissionId}": "delete_permission",
    "GET /drives": "list_shared_drives",
  },
  pages: {
    "GET /files": googlePageToken,
    "GET /drives": googlePageToken,
    "GET /files/{fileId}/permissions": googlePageToken,
    "GET /files/{fileId}/revisions": googlePageToken,
  },
  pageCursor: "argument",
} as const;
