// Prototype for decision 0010, not wired into the live provider: Stripe's
// failure mapper (`stripeFailure` in rest.ts) on the kit's error contract
// (src/http/errors.ts). Its suite maps the same answers through both and
// requires the same code, message, retry advice, and wait.
//
// What it shows: a 429 that is a lock conflict, decided by Stripe's
// machine-readable `code` and never by its prose; the `request-id` and
// `stripe-rate-limited-reason` headers, read only because they are on the
// reviewed allowlist; and the value-safety verdict, known before any detail
// is built, so a withheld operation's message never reaches the wording.

import { ConnectorCallError } from "../../errors.js";
import type { VendorErrors } from "../../http/errors.js";
import { withholdEmbeddedUrlsIn } from "../_shared/rest/value-safety.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Stripe's machine-readable error fields: tokens such as `card_error`, `lock_timeout`, `amount`. */
interface StripeFacts {
  readonly [name: string]: string | undefined;
  readonly type?: string | undefined;
  readonly code?: string | undefined;
  readonly declineCode?: string | undefined;
  readonly param?: string | undefined;
}

export const stripeErrors: VendorErrors<StripeFacts> = {
  provider: "Stripe",
  facts: (body) => {
    const error = record(record(body)["error"]);
    return {
      type: text(error["type"]),
      code: text(error["code"]),
      declineCode: text(error["decline_code"]),
      param: text(error["param"]),
    };
  },
  headers: ["request-id", "stripe-rate-limited-reason"],
  detail: ({ status, facts, headers, withheld, body }) => {
    const kind = [facts.type, facts.code, facts.declineCode].filter(Boolean).join(" ");
    const message = withheld
      ? "Stripe's message is withheld because this operation handles credentials."
      : (text(record(record(withholdEmbeddedUrlsIn(body))["error"])["message"]) ?? `Stripe returned HTTP ${status}.`);
    const requestId = headers["request-id"];
    return (
      `Stripe ${kind || `HTTP ${status}`}${facts.param ? ` (param ${facts.param})` : ""}: ` +
      `${message}${requestId ? ` Request ${requestId}.` : ""}`
    );
  },
  classify: [
    // Stripe did not process the request (docs.stripe.com/rate-limits#object-lock-timeouts):
    // a definite conflict, safe to retry once the other request finishes.
    ({ status, facts, detail }) =>
      status === 429 && facts.code === "lock_timeout"
        ? new ConnectorCallError(
            "conflict",
            `${detail} Another request is changing this object and Stripe did not process this one; retry after it finishes. This is a lock conflict, not a rate limit.`,
            { retryable: true, retryAfterMs: 1_000 },
          )
        : undefined,
  ],
  statuses: {
    429: ({ detail, headers, retryAfterMs }) => {
      const reason = headers["stripe-rate-limited-reason"];
      return new ConnectorCallError(
        "rate_limited",
        `${detail}${reason ? ` Limited by ${reason}.` : ""} Back off before retrying.`,
        { retryAfterMs: retryAfterMs ?? 1_000 },
      );
    },
    401: ({ detail }) =>
      new ConnectorCallError(
        "auth_required",
        `${detail} The configured Stripe key was rejected; an operator must replace it in this connection.`,
      ),
    403: ({ detail }) =>
      new ConnectorCallError(
        "provider_permission_denied",
        `${detail} A restricted key lacks this permission; an operator must grant it on the key or use another key.`,
      ),
    404: ({ detail }) => new ConnectorCallError("not_found", `${detail} Resolve the id with a list or search read.`),
    400: ({ detail }) => new ConnectorCallError("invalid_args", String(detail)),
    409: ({ detail }) => new ConnectorCallError("invalid_args", String(detail)),
    422: ({ detail }) => new ConnectorCallError("invalid_args", String(detail)),
    402: ({ detail }) => new ConnectorCallError("connector_call_failed", String(detail), { retryable: false }),
    424: ({ detail }) => new ConnectorCallError("unavailable", String(detail)),
    // Stripe's 5xx carries no wait; Retry-After is not passed on.
    serverError: ({ detail }) => new ConnectorCallError("unavailable", String(detail)),
  },
  unreadable: "Stripe returned a successful response that is not JSON.",
};
