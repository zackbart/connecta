import { boundedBody } from "../bounded-body.js";
import { byteReadResponse } from "../byte-read-response.js";
import { ConnectorCallError } from "../errors.js";
import { codeExchangeResponse } from "./downstream-oauth/consent.js";
import { authFlow, authInvoke, authMethod } from "./native.js";

type OAuthBodyStep = "metadata discovery" | "client registration" | "token exchange" | "token refresh";

// Metadata needs room for extensive scopes_supported lists. Token replies keep
// the existing refresh ceiling, including signed tokens. DCR can echo the
// requested scopes, so it needs the same room as metadata.
const LIMITS: Record<OAuthBodyStep, number> = {
  "metadata discovery": 65_536,
  "client registration": 65_536,
  "token exchange": 65_536,
  "token refresh": 65_536,
};

export class OAuthResponseTooLarge extends ConnectorCallError {
  constructor(connectorId: string, step: OAuthBodyStep) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" OAuth ${step} response exceeded ${LIMITS[step]} bytes.`,
      {
        retryable: false,
      },
    );
  }
}

/** Consume the source once, before SDK parsing, cloning, fallback or error logging. */
export const readOAuthResponse = authMethod(
  (response: Response, connectorId: string, step: OAuthBodyStep, signal?: AbortSignal) =>
    authFlow<Response>(function* () {
      const bounded = boundedBody(response, {
        limit: LIMITS[step],
        exceeded: () => new OAuthResponseTooLarge(connectorId, step),
      });
      const owned = signal ? codeExchangeResponse(bounded, signal) : bounded;
      const bytes = (yield authInvoke(owned, "arrayBuffer", [])) as ArrayBuffer;
      return byteReadResponse(
        new Response(response.body === null ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      );
    }),
);
