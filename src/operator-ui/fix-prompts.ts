import { renderFixPrompt, type FixPromptSpec } from "../fix-prompt.js";
import type { UiCredentialProblem, UiProblem } from "./model.js";

/**
 * Every failure the Connections page can show, with the prompt its "Copy fix
 * prompt" button puts on the clipboard.
 *
 * The signature is the guarantee. A prompt is looked up by kind and may name
 * the connector's configured id; there is no argument an error message, a
 * downstream body, or a credential could travel through, so none can reach a
 * coding agent's context by way of this page. The notice beside it is fixed
 * copy too wherever a downstream could have written the failure (see
 * `refusedNotice` in view.ts); what remains are the page's own sentences and a
 * credential form's field checks.
 */
export type FixPromptKind =
  | UiProblem
  | UiCredentialProblem
  | "credential_test_failed"
  | "oauth_action_failed"
  | "catalog_drift";

const CATALOGUE: Readonly<Record<FixPromptKind, FixPromptSpec>> = {
  connector_unavailable: {
    problem:
      "A connector is unavailable: its status check or catalog load failed, or did not finish before the operator page's deadline.",
    steps: [
      "Confirm the connector's downstream URL or API base in the deployment config, and that the deployment can reach it from where it runs.",
      "Check the credentials or headers the connector sends; a rejected credential often surfaces as a failed status rather than as an authorization prompt.",
      "If the downstream is slow rather than down, review the connector's timeouts and the deployment's discovery.probeTimeoutMs.",
    ],
  },
  oauth_required: {
    problem:
      "A downstream OAuth connector needs authorization: no grant is stored, or the stored grant expired or was revoked and could not be refreshed.",
    steps: [
      "Reauthorize from the operator page (Connect account or Reconnect OAuth) or with authorize_connector; this needs no code change if the grant simply lapsed.",
      "If it needs reauthorizing again soon after, check that the OAuth client requests offline access or a refresh token, and that the storage holding OAuth tokens persists across restarts and is shared by every instance.",
      "If authorization cannot start at all, check the connector's OAuth client configuration and the deployment's publicUrl, which forms the /oauth/callback/<connector id> redirect URI.",
    ],
  },
  credential_required: {
    problem:
      "A connector with an operator-managed credential slot has no usable credential stored.",
    steps: [
      "An operator with credential administration can add the credential on the operator page; that needs no code change.",
      "If nobody can, grant credential administration through the deployment's identity config (credentialAdministration for shared auth, personalConnection for personal auth), which is denied by default.",
      "Check that the connector's credential declaration (label and fields) matches what the downstream actually needs.",
    ],
  },
  auth_required: {
    problem:
      "A connector reports that it needs authorization, and its secret lives in deployment configuration rather than in an operator-managed slot.",
    steps: [
      "Find where the connector's secret is read (usually an environment variable or Worker secret passed into the connector config) and confirm it is set in the running environment.",
      "Rotate the secret at the provider if it expired or was revoked, then update the deployment's environment, not its source.",
      "If operators should manage this secret from the page instead, declare a credential slot on the connector and configure a credential vault.",
    ],
  },
  credential_mismatch: {
    problem:
      "The credential stored for a connector does not match the fields the connector currently declares, so it cannot be used.",
    steps: [
      "If the connector's credential fields changed on purpose, re-enter the credential on the operator page so the stored fields match.",
      "If they changed by accident, restore the previous field names in the connector's credential declaration.",
    ],
  },
  credential_unreadable: {
    problem:
      "A stored credential exists but could not be read or decrypted.",
    steps: [
      "Check that the credential vault's encryption key in the deployment environment is the one the credential was stored with; a rotated or missing key makes every stored value unreadable.",
      "Check the storage adapter backing the vault is reachable from the deployment.",
      "If the key was lost, remove and re-add the credential on the operator page; the old value cannot be recovered.",
    ],
  },
  credential_test_failed: {
    problem:
      "The test for a stored connector credential failed: the downstream rejected it, or the test could not reach the downstream.",
    steps: [
      "Confirm the stored value is current at the provider (not rotated, revoked, or scoped too narrowly), and replace it on the operator page if not.",
      "Check that the connector's credential test targets the same API base and auth scheme its tool calls use.",
    ],
  },
  oauth_action_failed: {
    problem:
      "Restarting or disconnecting a connector's downstream OAuth from the operator page failed.",
    steps: [
      "Check that the connector implements startAuth and disconnectAuth, and that the storage holding its OAuth state is writable.",
      "Check the connector's OAuth client configuration, including the authorization server it discovers or is given.",
      "Confirm the operator has the config-derived permission for this action (credentialAdministration for shared auth, personalConnection for personal auth).",
    ],
  },
  catalog_failed: {
    problem:
      "A connector reports itself connected, but loading its tool catalog failed, so none of its tools are being served.",
    steps: [
      "Check that the downstream still serves a complete tools list; connecta refuses a partial catalog rather than serving part of it.",
      "Check for tools the connector cannot accept: invalid schemas, missing descriptions, or names that collide.",
      "Pin or upgrade the @zackbart/connecta version if a maintained provider's catalog changed shape underneath it.",
    ],
  },
  catalog_drift: {
    problem:
      "A hosted provider's live catalog differs from the reviewed manifest shipped with connecta: new unclassified tools, unserved tools, annotation conflicts, or schema changes.",
    steps: [
      "Unclassified tools are withheld until a release classifies them. Check whether a newer @zackbart/connecta release has, and upgrade if so.",
      "If a tool the deployment depends on is now unserved or changed shape, review callers of it before upgrading.",
      "Report drift the release does not cover as an issue on the connecta repository, naming the provider and the kinds of drift but no tool data.",
    ],
  },
};

/** The clipboard text for one failure. Fixed by kind; see `CATALOGUE`. */
export function fixPrompt(kind: FixPromptKind, connectorId?: string): string {
  return renderFixPrompt(CATALOGUE[kind], connectorId);
}

/** Every kind, so a test can walk the whole catalogue. */
export const FIX_PROMPT_KINDS = Object.keys(CATALOGUE) as FixPromptKind[];
