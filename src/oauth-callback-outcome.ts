import { renderFixPrompt, type FixPromptSpec } from "./fix-prompt.js";

/**
 * Every way `/oauth/callback/<id>` can end, as a closed set. The route is
 * public and its inputs are attacker-influenced — the provider's `error`
 * parameter, and whatever a failed code exchange threw — so the page names a
 * reason from this list and never repeats either. The operator log names an
 * exchange failure too, in fixed text with at most a known OAuth error code:
 * the raw error can quote a token endpoint's echo of the client secret.
 *
 * `invalid_callback` is deliberately one reason, not four. An unknown id, a
 * connector without OAuth, a missing or mismatched state, and a verifier that
 * threw must stay byte-identical, or the page becomes the connector-enumeration
 * oracle the flat refusal exists to deny — so "expired" is folded in rather
 * than told apart.
 */
export type OAuthCallbackReason =
  | "connected"
  | "denied"
  | "provider_error"
  | "invalid_callback"
  | "handoff_failed"
  | "exchange_failed";

/**
 * How a page reads at a glance: `ok` for a stored grant, `declined` for a
 * consent a person turned down on purpose, `problem` for everything that
 * failed. The page pairs each with a shape and a label, never color alone.
 */
type OAuthCallbackTone = "ok" | "declined" | "problem";

interface OAuthCallbackOutcome {
  status: number;
  tone: OAuthCallbackTone;
  /**
   * The page heading. `{name}` is the connector's title (or id), and appears
   * only in outcomes that set `namesConnector`.
   */
  heading: string;
  /** `{product}` is the deployment's product name. */
  message: string;
  /** Absent only for success, which has nothing to fix. */
  fix?: FixPromptSpec;
  /**
   * Whether the page may name the connector: only after the state check proved
   * the flow was one this deployment started for it. Every outcome reachable
   * before that point renders the same bytes whatever id the URL carried.
   */
  namesConnector?: boolean;
}

const OUTCOMES: Readonly<Record<OAuthCallbackReason, OAuthCallbackOutcome>> = {
  connected: {
    status: 200,
    tone: "ok",
    heading: "{name} is connected",
    message: "You can close this window.",
    namesConnector: true,
  },
  denied: {
    status: 400,
    tone: "declined",
    heading: "Authorization was declined",
    message:
      "Consent was declined at the provider, so nothing was stored. Start authorization again whenever you are ready.",
    fix: {
      problem: "Consent for a downstream OAuth connector was declined at the provider, so no grant was stored.",
      steps: [
        "If consent was declined on purpose, nothing in code needs to change: restart authorization from the operator page or authorize_connector when ready.",
        "If the consent screen asked for more than the connector needs, narrow the scopes the connector's OAuth configuration requests.",
        "If the provider refused the account or organization, check the OAuth app's allowed users or install policy in the provider's console.",
      ],
    },
  },
  provider_error: {
    status: 400,
    tone: "problem",
    heading: "The provider returned an error",
    message: "It sent back an error instead of an authorization code, so nothing was stored.",
    fix: {
      problem: "A provider redirected back to the OAuth callback with an OAuth error instead of an authorization code.",
      steps: [
        "Compare the provider's OAuth client registration with the connector's configuration: client id, requested scopes, and the redirect URI, which is the deployment's public URL followed by /oauth/callback/<connector id>.",
        "Check that the deployment's publicUrl is the origin the provider redirects to; a different origin yields a redirect URI the provider does not recognize.",
        "Retry once before changing code: a provider outage answers with the same kind of error.",
      ],
    },
  },
  invalid_callback: {
    status: 400,
    tone: "problem",
    heading: "Authorization could not be completed",
    message:
      "The link may be expired, already used, or replaced by a newer attempt. Start authorization again from {product}.",
    fix: {
      problem:
        "An OAuth callback arrived that the deployment could not match to an authorization flow it started: stale, already used, replaced by a newer attempt, or finished in a different session.",
      steps: [
        "Restart authorization from the operator page or authorize_connector and finish consent in one pass; restarting invalidates the previous link.",
        "If it fails every time, confirm the connector implements both finishAuth and verifyState, and that the storage holding OAuth state is shared by every instance serving the deployment (memoryStorage is per-process).",
        "For personal-auth connectors, finish consent signed in as the same operator who started it.",
      ],
    },
  },
  handoff_failed: {
    status: 500,
    tone: "problem",
    heading: "{name} could not be connected",
    message: "Authorization could not be completed, and nothing was exchanged. Try again shortly.",
    namesConnector: true,
    fix: {
      problem:
        "The deployment could not consume the stored principal handoff for a personal-auth OAuth flow, so no authorization code was exchanged.",
      steps: [
        "Check the deployment's storage adapter: that it is reachable, writable, and consistent across every instance serving the deployment.",
        "Find the [connecta] warning for this callback in the deployment logs; it records the storage error the page withholds.",
      ],
    },
  },
  exchange_failed: {
    status: 500,
    tone: "problem",
    heading: "{name} could not be connected",
    message: "The provider did not accept the authorization code exchange. Nothing was stored.",
    namesConnector: true,
    fix: {
      problem: "A provider returned an authorization code, but exchanging it for tokens failed.",
      steps: [
        "Check the OAuth client credentials the connector uses — client id and secret in the deployment's environment — and that they belong to the same OAuth app that showed the consent screen.",
        "Check that the token endpoint and redirect URI the connector uses match the provider's registration exactly.",
        "Find the [connecta] warning for this callback in the deployment logs; it records the exchange error the page withholds.",
      ],
    },
  },
};

/**
 * RFC 6749 names `access_denied` for a declined consent (section 4.1.2.1). Every other
 * value, standard or invented, is the provider refusing the request itself —
 * and is never echoed, because the callback cannot tell a provider's code from
 * one an attacker typed into the URL.
 */
export function providerErrorReason(error: string): OAuthCallbackReason {
  return error === "access_denied" ? "denied" : "provider_error";
}

export interface RenderedCallbackOutcome {
  reason: OAuthCallbackReason;
  status: number;
  tone: OAuthCallbackTone;
  /** Plain text; the page escapes it, since it can carry a connector title. */
  heading: string;
  message: string;
  fixPrompt?: string;
}

/**
 * Page copy and fix prompt for one reason. Nothing here reads the request.
 *
 * `connector` is read only for a reason that sets `namesConnector`. The route
 * passes one only once the state check has proved the flow, and this gate
 * keeps a caller that passed one earlier from naming it anyway. `productName`
 * is deployment configuration, the same for every connector, so it cannot
 * tell one refusal from another.
 */
export function oauthCallbackOutcome(
  reason: OAuthCallbackReason,
  connector?: { id: string; title?: string | undefined },
  productName = "Connecta",
): RenderedCallbackOutcome {
  const outcome = OUTCOMES[reason];
  const named = outcome.namesConnector ? connector : undefined;
  const name = named ? displayName(named) : "The connection";
  return {
    reason,
    status: outcome.status,
    tone: outcome.tone,
    heading: outcome.heading.replace("{name}", () => name),
    message: outcome.message.replace("{product}", () => productName),
    ...(outcome.fix ? { fixPrompt: renderFixPrompt(outcome.fix, named?.id) } : {}),
  };
}

/** A connector's title when it has a usable one, otherwise its id. */
function displayName(connector: { id: string; title?: string | undefined }): string {
  const title = typeof connector.title === "string" ? connector.title.trim() : "";
  return title || connector.id;
}
