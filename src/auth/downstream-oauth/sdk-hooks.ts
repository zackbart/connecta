// KvOAuthProvider's OAuthClientProvider hooks: what the SDK reads and saves
// for client registration, discovery, tokens and the PKCE verifier.
import type {
  OAuthClientInformationContext,
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { authCall, authFlow, authInvoke, authMethod, authValue } from "../native.js";
import { discoveryIssuer } from "../oauth-grant.js";
import type { KvOAuthProvider } from "../downstream-oauth.js";
import { aborted } from "./refresh-coordinator.js";
import { type Grant, type GrantBody, fingerprint } from "./grant-store.js";
import { oauthStateDigest, randomState } from "./consent.js";

/** KvOAuthProvider's SDK hooks; `authMethods` installs them. */
export const sdkHookMethods = {
  clientInformation: function (this: KvOAuthProvider, ctx?: OAuthClientInformationContext) {
    return authFlow<OAuthClientInformationMixed | undefined>(
      function* (this: KvOAuthProvider) {
        if (this.signal?.aborted) throw aborted(this.signal);
        const { body } = (yield authInvoke(this, "activeGrant", [])) as Grant;
        if (this.signal?.aborted) throw aborted(this.signal);
        const client = this.clientOptions?.client;
        if (!body.client && !this.allowAuthorization) throw this.authorizationRefused();
        if (client) {
          if ((ctx && ctx.issuer !== client.issuer) || body.issuer !== client.issuer) throw this.flowSuperseded();
          if (
            body.client &&
            (body.client.value.client_id !== client.clientId || body.client.binding !== this.clientBinding)
          )
            throw this.flowSuperseded();
          return {
            client_id: client.clientId,
            issuer: client.issuer,
            token_endpoint_auth_method: this.clientMetadata.token_endpoint_auth_method,
            ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}),
          };
        }
        if (!body.client || (ctx && body.issuer !== ctx.issuer)) return undefined;
        this.seen.client = fingerprint(body.client.value);
        return ctx ? { ...body.client.value, issuer: ctx.issuer } : body.client.value;
      }.bind(this),
    );
  },
  saveClientInformation: function (
    this: KvOAuthProvider,
    info: OAuthClientInformationMixed,
    ctx?: OAuthClientInformationContext,
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        try {
          const { body } = (yield authInvoke(this, "boundGrant", [])) as Grant;
          const registrationPath = this.clientOptions?.client
            ? "static"
            : body.client?.value.client_id === info.client_id && body.client.registrationPath
              ? body.client.registrationPath
              : this.clientMetadataUrl &&
                  body.discovery?.authorizationServerMetadata?.client_id_metadata_document_supported === true
                ? "cimd"
                : "dcr";
          (yield authInvoke(this, "writeCredential", [
            "client",
            {
              value: this.clientOptions?.client ? { client_id: this.clientOptions.client.clientId } : info,
              registrationPath,
              ...(this.clientBinding !== undefined ? { binding: this.clientBinding } : {}),
            },
            ctx?.issuer,
          ])) as void;
        } catch (error) {
          if (!this.signal?.aborted) throw error;
        }
      }.bind(this),
    );
  },
  registrationPath: function (this: KvOAuthProvider) {
    return authFlow<"cimd" | "dcr" | "static" | undefined>(
      function* (this: KvOAuthProvider) {
        const { body } = (yield authInvoke(this, "boundGrant", [])) as Grant;
        return body.client?.registrationPath;
      }.bind(this),
    );
  },
  validatedIssuerOrigin: function (this: KvOAuthProvider) {
    return authFlow<string | undefined>(
      function* (this: KvOAuthProvider) {
        const { body } = (yield authInvoke(this, "boundGrant", [])) as Grant;
        const state = body.discovery;
        if (
          !state ||
          state.authorizationServerMetadata?.issuer !== state.authorizationServerUrl ||
          body.issuer !== state.authorizationServerUrl
        )
          return undefined;
        this.assertCredentialFree(state, body);
        return new URL(state.authorizationServerUrl).origin;
      }.bind(this),
    );
  },
  discoveryState: function (this: KvOAuthProvider) {
    return authFlow<OAuthDiscoveryState | undefined>(
      function* (this: KvOAuthProvider) {
        if (this.signal?.aborted) throw aborted(this.signal);
        const { body } = (yield authInvoke(this, "activeGrant", [])) as Grant;
        if (this.signal?.aborted) throw aborted(this.signal);
        let state = body.discovery;
        if (state?.resourceMetadataUrl && this.clientOptions?.resourceOrigin) {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(state.resourceMetadataUrl).origin === this.clientOptions.resourceOrigin;
          } catch {
            // A malformed legacy URL is no more usable than a foreign one.
          }
          if (!sameOrigin) {
            // Never hand the SDK a legacy foreign URL or its resource
            // document. Keep the issuer binding for callbacks, but force
            // same-origin resource discovery on every SDK path. This read
            // does not mutate the stored grant.
            state = { ...state };
            delete state.resourceMetadataUrl;
            delete state.resourceMetadata;
          }
        }
        this.assertCredentialFree(state, body);
        // Bind consent to durable discovery until the SDK saves a new
        // state. A same-origin metadata 404 can leave the cache unchanged.
        this.consentDiscovery = body.discovery;
        return state;
      }.bind(this),
    );
  },
  saveDiscoveryState: function (this: KvOAuthProvider, state: OAuthDiscoveryState) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        this.assertCredentialFree(state, ((yield authInvoke(this, "boundGrant", [])) as Grant).body);
        const issuer = discoveryIssuer(state);
        if (this.clientOptions?.client && issuer !== this.clientOptions.client.issuer) throw this.flowSuperseded();
        if (!this.allowAuthorization && !((yield authInvoke(this, "boundGrant", [])) as Grant).body.client)
          throw this.authorizationRefused();
        this.consentDiscovery = state;
        (yield authInvoke(this, "updateGrant", [
          (grant: Grant) => {
            const body: GrantBody =
              grant.body.issuer !== issuer ? (issuer !== undefined ? { issuer } : {}) : { ...grant.body };
            this.assertCredentialFree(state, grant.body);
            body.discovery = state;
            return this.withIssuer(grant, body);
          },
        ])) as boolean;
      }.bind(this),
    );
  },
  tokens: function (this: KvOAuthProvider, ctx?: OAuthClientInformationContext) {
    return authFlow<OAuthTokens | undefined>(
      function* (this: KvOAuthProvider) {
        if (this.signal?.aborted) throw aborted(this.signal);
        const grant = (yield authInvoke(this, "activeGrant", [])) as Grant;
        if (this.signal?.aborted) throw aborted(this.signal);
        const { tokens } = grant.body;
        if (!tokens || (ctx && grant.body.issuer !== ctx.issuer)) return undefined;
        this.seen.tokens = fingerprint(tokens);
        if (!ctx) return tokens;
        this.refreshBasis = { accessToken: tokens.access_token, epoch: grant.epoch, issuer: ctx.issuer };
        return { ...tokens, issuer: ctx.issuer };
      }.bind(this),
    );
  },
  saveTokens: function (this: KvOAuthProvider, tokens: OAuthTokens, ctx?: OAuthClientInformationContext) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        if (this.signal?.aborted) throw aborted(this.signal);
        if (this.refreshFailure?.kind === "dead") throw this.authorizationRefused();
        // The coordinator stored this refresh already, or handed on another's.
        if (this.storedRefresh !== undefined && tokens.access_token === this.storedRefresh) return;
        const refreshConsent =
          this.exchangeConsent &&
          tokens.refresh_token !== undefined &&
          this.exchangeConsent.digest ===
            ((yield authInvoke(this, "wait", [
              authMethod(() => {
                return authCall(oauthStateDigest, [tokens.refresh_token!]) as Effect.Effect<string, unknown>;
              }),
            ])) as string)
            ? this.exchangeConsent
            : undefined;
        (yield authInvoke(this, "writeCredential", ["tokens", tokens, ctx?.issuer, refreshConsent])) as void;
        this.refreshFailure = undefined;
      }.bind(this),
    );
  },
  state: function (this: KvOAuthProvider) {
    return authValue<string>(() => {
      if (!this.allowAuthorization) throw this.authorizationRefused();
      const state = randomState();
      this.consent = { state };
      return state;
    });
  },
  saveCodeVerifier: function (this: KvOAuthProvider, verifier: string) {
    return authValue<void>(() => {
      if (this.signal?.aborted) throw aborted(this.signal);
      if (!this.allowAuthorization) throw this.authorizationRefused();
      this.consent = { ...this.consent, verifier };
    });
  },
  codeVerifier: function (this: KvOAuthProvider) {
    return authValue<string>(() => {
      const verifier = this.callback?.flow.verifier ?? this.consent.verifier;
      if (verifier === undefined) {
        throw new Error(`No PKCE code verifier for "${this.connectorId}"`);
      }
      return verifier;
    });
  },
  invalidateCredentials: function (
    this: KvOAuthProvider,
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        if (this.signal?.aborted) throw aborted(this.signal);
        const fields = {
          all: ["client", "tokens", "discovery"],
          client: ["client"],
          tokens: ["tokens"],
          discovery: ["discovery"],
          verifier: [],
        }[scope] as Array<"client" | "tokens" | "discovery">;
        if (fields.length > 0) {
          (yield authInvoke(this, "updateGrant", [
            (grant: Grant) => {
              const body: GrantBody = { ...grant.body };
              let changed = false;
              for (const field of fields) {
                const current = field === "client" ? body.client?.value : body[field];
                if (current === undefined) continue;
                if (field !== "discovery" && fingerprint(current) !== this.seen[field]) continue;
                delete body[field];
                if (field === "tokens") delete body.expiresAt;
                changed = true;
              }
              return changed ? { ...grant, body } : undefined;
            },
            { quiet: true },
          ])) as boolean;
        }
        // The SDK invalidates after a refused refresh and then starts over, which
        // on `invalid_client` means registering a new client. A passive request
        // must not begin authorization, so it ends here, as auth_required.
        if (!this.allowAuthorization && this.refreshFailure?.kind === "dead") {
          throw this.authorizationRefused();
        }
      }.bind(this),
    );
  },
};
