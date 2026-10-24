// Opt-in plumbing only. Product PRs supply their reviewed literal verdicts.
import { Effect } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import type { HatchBinding } from "../../../http/hatch.js";
import type { Connection } from "../../../http/vendor.js";
import type { RestCall } from "../rest/tools.js";
import type { OperationIndex } from "../rest/operation-index.js";

export function requireGoogleIndex(index: OperationIndex | undefined): void {
  if (!index) throw new Error("Google requests require their reviewed operation index.");
  if (index.pathMatching !== "uri-template") throw new Error('Google indexes require pathMatching: "uri-template".');
}

/** Independent of compact schema depth: only reviewed batch kinds can execute. */
export function googleBatchGuard(
  body: unknown,
  options: { readonly kinds: readonly string[]; readonly revision: boolean; readonly max?: number },
): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "A Google batch body must be an object.";
  const value = body as Record<string, unknown>;
  const requests = value["requests"];
  if (!Array.isArray(requests) || !requests.length || requests.length > (options.max ?? 100))
    return `A Google batch needs 1–${options.max ?? 100} requests.`;
  if (
    requests.some(
      (request) =>
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).length !== 1 ||
        !options.kinds.includes(Object.keys(request)[0]!),
    )
  )
    return "Each Google batch request must contain exactly one reviewed request kind.";
  const control = value["writeControl"] as Record<string, unknown> | undefined;
  if (
    options.revision &&
    (!control || typeof control["requiredRevisionId"] !== "string" || !control["requiredRevisionId"].trim())
  )
    return "This Google batch needs a nonempty writeControl.requiredRevisionId from a current read.";
  return undefined;
}

/** Ensure a substituted named id still reaches the endpoint the tool declared. */
export function googleNamedOperation(index: OperationIndex, method: string, path: string, template: string): void {
  requireGoogleIndex(index);
  if (index.resolve(method, path).op.path !== template)
    throw new ConnectorCallError(
      "invalid_args",
      "This Google id resolves to a different operation; no request was sent.",
    );
}

export function googleHatchBinding(
  connection: Connection,
  options: {
    readonly index: OperationIndex;
    readonly review: string;
    readonly refusal?: HatchBinding["refusal"];
    readonly refuse?: (call: RestCall) => string | undefined;
    readonly revisionGuarded?: (call: RestCall) => boolean;
    /** After hatch admission, inspect a detached request and wrap its one confined send. */
    readonly wrapSend?: (
      call: RestCall,
      send: () => ReturnType<HatchBinding["send"]>,
    ) => ReturnType<HatchBinding["send"]>;
  },
): HatchBinding {
  requireGoogleIndex(options.index);
  return {
    index: options.index,
    ...(options.wrapSend ? { warnings: true as const } : {}),
    review: options.review,
    ...(options.refusal ? { refusal: options.refusal } : {}),
    refuse: (call) => {
      for (const match of call.path.matchAll(/%([a-f0-9]{2})/gi))
        if (/^[-A-Za-z0-9._~:]$/.test(String.fromCharCode(parseInt(match[1]!, 16))))
          return "Google paths must spell unreserved characters and action separators literally.";
      if (call.headers && Object.keys(call.headers).length) return "Google hatches do not accept caller headers.";
      for (const key of Object.keys(call.query))
        if (
          [
            "access_token",
            "oauth_token",
            "key",
            "callback",
            "upload_protocol",
            "uploadType",
            "userId",
            "quotaUser",
          ].includes(key)
        )
          return `Google query.${key} is owned by the deployment and cannot be selected by a caller.`;
      if (call.query["alt"] !== undefined && call.query["alt"] !== "json")
        return "Google hatches return JSON only; use a named content tool for media.";
      return options.refuse?.(call);
    },
    send: (call, sendOptions) =>
      Effect.suspend(() => {
        // Capture the admitted wire request before the wrapper can inspect its copy.
        const request = {
          method: call.method,
          path: call.path,
          template: call.op.path,
          query: Object.entries(call.query).flatMap(([name, value]) =>
            value === undefined
              ? []
              : (Array.isArray(value) ? value : [value]).map((item) => [name, String(item)] as [string, string]),
          ),
          headers: { accept: "application/json" },
          ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
        };
        const optionsForSend = {
          ...sendOptions,
          ...(options.revisionGuarded?.(call) ? { flags: { revisionGuarded: true as const } } : {}),
        };
        let sent = false;
        const send = () =>
          Effect.suspend(() => {
            if (sent) return Effect.die(new Error("A Google hatch wrapper may send its admitted request only once."));
            sent = true;
            return connection.sendPath(request, optionsForSend);
          });
        return options.wrapSend ? options.wrapSend(structuredClone(call), send) : send();
      }),
  };
}
