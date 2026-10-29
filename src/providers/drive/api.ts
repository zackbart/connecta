// Drive's declared methods, delegated grant and two separately confined connections.
import { Effect, Schema } from "effect";
import { guardedClient } from "../../http/client.js";
import { bearer, Grant, refreshOnce } from "../../http/oauth.js";
import { resultSafety } from "../../http/safety.js";
import { connect, del, get, patch, post, type Connection, type ConnectOptions } from "../../http/vendor.js";
import type { HttpFailure, OperationRef } from "../../http/errors.js";
import type { CallServices } from "../../http/services.js";
import {
  GOOGLE_GRANT_RENEWAL,
  googleClient,
  googleErrors,
  googleGrant,
  workspaceOf,
  type GoogleClient,
  type GoogleProduct,
  type GoogleRequest,
  type GoogleRequestOptions,
} from "../_shared/google/kit.js";
import { DRIVE_API_BASE_URL, DRIVE_MAX_RESPONSE_BYTES, DRIVE_SCOPES } from "./lib/constants.js";
import { indexedVendor } from "../_shared/rest/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { driveIndex } from "./lib/hatch.js";
import { DRIVE_VALUE_SAFETY, withholdDriveLinks } from "./safety.js";
import type { DriveOptions } from "./index.js";

export const DRIVE: GoogleProduct = {
  provider: "Google Drive",
  api: "Google Drive API",
  scopes: DRIVE_SCOPES,
  notFound: "ambiguous",
};

const FileId = { fileId: Schema.String };
const PermissionId = { ...FileId, permissionId: Schema.String };
const getFile = get("getFile", "/files/:fileId", { params: FileId, success: Schema.Unknown });
const OPERATIONS = [
  get("listFiles", "/files", { success: Schema.Unknown }),
  post("createFile", "/files", { payload: Schema.Unknown, success: Schema.Unknown }),
  getFile,
  patch("updateFile", "/files/:fileId", { params: FileId, payload: Schema.Unknown, success: Schema.Unknown }),
  post("copyFile", "/files/:fileId/copy", { params: FileId, payload: Schema.Unknown, success: Schema.Unknown }),
  get("exportFile", "/files/:fileId/export", { params: FileId, success: Schema.Unknown }),
  get("listPermissions", "/files/:fileId/permissions", { params: FileId, success: Schema.Unknown }),
  post("createPermission", "/files/:fileId/permissions", {
    params: FileId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  patch("updatePermission", "/files/:fileId/permissions/:permissionId", {
    params: PermissionId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  del("deletePermission", "/files/:fileId/permissions/:permissionId", {
    params: PermissionId,
    success: Schema.Unknown,
  }),
  get("listDrives", "/drives", { success: Schema.Unknown }),
] as const;

const indexed = indexedVendor("Google Drive", driveIndex, OPERATIONS);
export const DriveApi = {
  ...indexed,
  manifestBase: "/drive/v3",
  indexed: { ...indexed.indexed!, operations: driveIndex.ops.map((op) => `${op.method} /drive/v3${op.path}`).sort() },
  binaryBodies: {
    review:
      "Drive media downloads and native-file exports retain bounded bytes regardless of Content-Type, including JSON files. Only googleClient.bytes sets googleBytes; metadata and uploads still require JSON. The kit checks sent secrets before any result hook or base64 decode.",
    forResponse: (_status: number, operation: OperationRef) => operation.flags?.["googleBytes"] === true,
  },
};
const google = googleErrors(DRIVE, { standard: true });
export const errors: ReturnType<typeof googleErrors> = {
  ...google,
  meanings: { ...google.meanings!, conflicts: ["A Drive source page changed before its local cursor resumed"] },
};
const values = valueSafety(DRIVE_VALUE_SAFETY, () => driveIndex);
export const safety = {
  reviewed: {
    resolve: (method: string, path: string) => {
      const op = driveIndex.resolve(method, path).op;
      return { method: op.method, template: op.path };
    },
    redact: (data: unknown, op: { method: string; template: string }) =>
      withholdDriveLinks(values.redact(data, op.method, op.template)),
    withholds: (op: { method: string; template: string }) => values.withholds(op.method, op.template),
    withholdsErrors: (op: { method: string; template: string }) =>
      values.withholdsErrors(driveIndex.ops.find((entry) => entry.method === op.method && entry.path === op.template)!),
  },
  sensitiveFields: { names: [], choice: "drop" },
} as const;

/** Keep only redacted content headers beside the kit's already safe binary envelope. */
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) =>
  Effect.succeed(
    answer.operation.flags?.["googleBytes"]
      ? {
          body,
          contentType: answer.headers.get("content-type") ?? undefined,
          contentRange: answer.headers.get("content-range") ?? undefined,
        }
      : body,
  );

// Both connections share this exact grant program and its once-per-call subject memo.
// Only the service-account token cache's strings and expiries cross requests.
const grants = new WeakMap<object, ReturnType<typeof googleGrant>>();
export function driveGrant(options: Readonly<DriveOptions>): ReturnType<typeof googleGrant> {
  let grant = grants.get(options);
  if (!grant) {
    grant = googleGrant(DRIVE, workspaceOf("drive", options));
    grants.set(options, grant);
  }
  return grant;
}

/** The upload host beside an API root: `…/drive/v3` → `…/upload/drive/v3`. */
function uploadBaseUrl(apiBase: string): string {
  const url = new URL(apiBase);
  return `${url.origin}/upload${url.pathname.replace(/\/+$/, "")}`;
}

/** Stripe's fixed secondary-connection pattern, built once by driveTools, outside all caller contexts. */
export function driveUploadConnection(options: Readonly<DriveOptions>): Connection {
  const grant = driveGrant(options);
  const connected = connect(
    DriveApi,
    refreshOnce(
      guardedClient({
        provider: DRIVE.provider,
        baseUrl: uploadBaseUrl(options.baseUrl?.trim() || DRIVE_API_BASE_URL),
        maxResponseBytes: DRIVE_MAX_RESPONSE_BYTES,
        authenticate: bearer,
      }),
      GOOGLE_GRANT_RENEWAL,
    ),
    { errors, safety: resultSafety(safety), result },
  );
  const authorize = <A>(work: Effect.Effect<A, HttpFailure, CallServices | Grant>) =>
    work.pipe(Effect.provideServiceEffect(Grant, grant));
  return {
    ...connected,
    send: (...args) => authorize(connected.send(...args)),
    sendPath: (...args) => authorize(connected.sendPath(...args)),
    sendItem: (...args) => authorize(connected.sendItem(...args)),
  };
}

interface DriveBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly contentRange: string | undefined;
  readonly status: number;
  readonly truncated: boolean;
}
type ReadOptions = GoogleRequestOptions & { readonly maxBytes?: number };
export interface DriveClient {
  readonly json: GoogleClient["json"];
  readonly bytes: (
    request: GoogleRequest,
    accept?: string,
    options?: ReadOptions,
  ) => Effect.Effect<DriveBytes, HttpFailure, CallServices>;
  readonly text: (
    request: GoogleRequest,
    accept?: string,
    options?: ReadOptions,
  ) => Effect.Effect<Omit<DriveBytes, "bytes"> & { text: string }, HttpFailure, CallServices>;
}

/** Named requests keep their declared endpoint even when an id collides with a literal route. */
export function driveClient(connection: Connection): DriveClient {
  const client = googleClient(connection, driveIndex);
  const named = (request: GoogleRequest): GoogleRequest => ({
    ...request,
    template: request.path
      .replace(/^(\/files\/)[^/]+/, "$1{fileId}")
      .replace(/(\/permissions\/)[^/]+$/, "$1{permissionId}"),
  });
  return driveContentClient({
    json: (request, options) => client.json(named(request), options),
    bytes: (request, accept, options) => client.bytes(named(request), accept, options),
  });
}
/** Charset handling and Google's empty-file Range status, over already safe bytes. */
export function driveContentClient(client: GoogleClient): DriveClient {
  const bytes: DriveClient["bytes"] = (request, accept, options) =>
    client.bytes(request, accept, options).pipe(
      Effect.map((answer) => {
        const data = answer.data as {
          body: { base64: string } | null;
          contentType: string | undefined;
          contentRange: string | undefined;
        };
        // The core encoded sent-secret-safe bytes before result and value safety;
        // only that safe representation is decoded here, never a raw response.
        const binary = data.body ? atob(data.body.base64) : "";
        const decoded = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
        return {
          bytes: decoded,
          contentType: data.contentType,
          contentRange: data.contentRange,
          status: answer.status,
          truncated: answer.prefix?.truncated ?? false,
        };
      }),
      Effect.catchTag("StatusFailure", (failure) =>
        options?.maxBytes !== undefined &&
        failure.status === 416 &&
        /^bytes \*\/0$/i.test(failure.headers.get("content-range")?.trim() ?? "")
          ? Effect.succeed({
              bytes: new Uint8Array(),
              contentType: failure.headers.get("content-type") ?? undefined,
              contentRange: failure.headers.get("content-range") ?? undefined,
              status: 416,
              truncated: false,
            })
          : Effect.fail(failure),
      ),
    );
  return {
    json: client.json,
    bytes,
    text: (request, accept = "text/plain, */*", options) =>
      bytes(request, accept, options).pipe(
        Effect.map(({ bytes, ...rest }) => {
          const charset = /charset="?([^";\s]+)"?/i.exec(rest.contentType ?? "")?.[1] ?? "utf-8";
          let text: string;
          try {
            text = new TextDecoder(charset).decode(bytes, { stream: rest.truncated });
          } catch {
            text = new TextDecoder().decode(bytes, { stream: rest.truncated });
          }
          return { text, ...rest };
        }),
      ),
  };
}

/** Delegation has no operator-managed credential to probe. */
export const probe = {
  operation: getFile,
  request: { params: { fileId: "-" } },
  describe: () => "Google Drive delegation has no credential to test.",
};
