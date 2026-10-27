import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleServiceAccountToken, type GoogleServiceAccountTokenOptions } from "../src/google.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConfigError } from "../src/config-schema.js";
import { connectorContext, deferred, waitFor } from "./fixtures/misc.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { PRIVATE_KEY } from "./fixtures/rsa.js";
import { createTestConnecta } from "./helpers.js";

const SCOPE = "https://www.googleapis.com/auth/bigquery";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
let serial = 0;
function options(): GoogleServiceAccountTokenOptions {
  return {
    serviceAccount: { clientEmail: `warehouse-${++serial}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    scopes: [SCOPE],
  };
}

const assertions: string[] = [];
let response: (() => Response | Promise<Response>) | undefined;
beforeEach(() => {
  installOwnedTransport();
  assertions.length = 0;
  response = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      expect(String(input)).toBe(TOKEN_URL);
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      assertions.push(form.get("assertion")!);
      return response
        ? await response()
        : Response.json({ access_token: `minted-token-${assertions.length}`, expires_in: 3600 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function decode(part: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

describe("Google service-account request tokens", () => {
  it.each([undefined, "alice@example.com"])("signs a verifiable assertion with subject %s", async (subject) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const opts = { ...options(), ...(subject === undefined ? {} : { subject }) };
    const account = opts.serviceAccount as { clientEmail: string; privateKey: string };
    const token = googleServiceAccountToken(opts);
    expect(await token(connectorContext())).toBe("minted-token-1");
    const [header, body, signature] = assertions[0]!.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(decode(body)));
    expect(claims).toEqual({
      iss: account.clientEmail,
      ...(subject ? { sub: subject } : {}),
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
    });
    const der = Uint8Array.from(atob(PRIVATE_KEY.replace(/-----[A-Z ]+-----|\s/g, "")), (char) => char.charCodeAt(0));
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["sign"],
    );
    const { n, e, kty } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { n: n!, e: e!, kty: kty! },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${body}`),
      ),
    ).toBe(true);
  });

  it("reuses tokens until the refresh margin and shares a concurrent mint", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const token = googleServiceAccountToken(options());
    const pending = deferred<Response>();
    response = () => pending.promise;
    const calls = Array.from({ length: 5 }, () => token(connectorContext()));
    await waitFor(() => assertions.length === 1);
    pending.resolve(Response.json({ access_token: "first-token", expires_in: 3600 }));
    expect(await Promise.all(calls)).toEqual(Array(5).fill("first-token"));
    now += 3_539_000;
    expect(await token(connectorContext())).toBe("first-token");
    expect(assertions).toHaveLength(1);
    now += 1_000;
    response = undefined;
    expect(await token(connectorContext())).toBe("minted-token-2");
  });

  it("partitions by subject, scope set and signing key, including separate helper instances", async () => {
    const opts = options();
    const keyPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
    const rotatedKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
    const mint = async (config: GoogleServiceAccountTokenOptions) =>
      await googleServiceAccountToken(config)(connectorContext());
    expect(await mint(opts)).toBe("minted-token-1");
    expect(await mint({ ...opts, subject: "alice@example.com" })).toBe("minted-token-2");
    expect(await mint({ ...opts, subject: "ALICE@example.com" })).toBe("minted-token-2");
    expect(await mint({ ...opts, scopes: [SCOPE, "https://www.googleapis.com/auth/cloud-platform"] })).toBe(
      "minted-token-3",
    );
    expect(await mint({ ...opts, scopes: ["https://www.googleapis.com/auth/cloud-platform", SCOPE, SCOPE] })).toBe(
      "minted-token-3",
    );
    expect(
      await mint({ ...opts, serviceAccount: { ...(opts.serviceAccount as object), privateKey: rotatedKey } as never }),
    ).toBe("minted-token-4");
    expect(await mint(opts)).toBe("minted-token-1");
    expect(assertions).toHaveLength(4);
  });

  it("forgets only the rejected token, leaving a concurrent replacement intact", async () => {
    const token = googleServiceAccountToken(options());
    expect(await token(connectorContext())).toBe("minted-token-1");
    await token.invalidate!("minted-token-1", connectorContext());
    expect(await token(connectorContext())).toBe("minted-token-2");
    await token.invalidate!("minted-token-1", connectorContext());
    expect(await token(connectorContext())).toBe("minted-token-2");
    expect(assertions).toHaveLength(2);
  });

  it.each(["invalid_grant", "invalid_client", "disabled_client", "access_denied", "invalid_scope", "unknown-error"])(
    "withholds hostile token errors (%s) and gives non-delegated guidance",
    async (error) => {
      const secret = "ASSERTION_TOKEN_KEY_SENTINEL";
      response = () =>
        Response.json({ error, error_description: `${secret} ${PRIVATE_KEY} ${assertions[0]}` }, { status: 400 });
      const failure = (await googleServiceAccountToken(options())(connectorContext()).catch(
        (error: unknown) => error,
      )) as Error;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toMatch(/Workspace|delegat|ASSERTION_TOKEN_KEY_SENTINEL|BEGIN PRIVATE KEY/);
      expect(failure.message).not.toContain(assertions[0]);
      if (error === "invalid_grant") expect(failure.message).toMatch(/key.*disabled.*clock/);
      if (error === "invalid_scope") expect(failure.message).toContain("IAM");
    },
  );

  it("validates at construction without exposing credential values", () => {
    const opts = options();
    for (const override of [
      { serviceAccount: "secret-value" },
      { serviceAccount: JSON.stringify({ type: "secret-value" }) },
      { serviceAccount: { clientEmail: "alice@example.com", privateKey: "secret-value" } },
      { scopes: [] },
      { scopes: ["http://example.com/scope"] },
      { scopes: ["https://user:secret-value@example.com/scope"] },
      { scopes: ["https://example.com/has space"] },
      { scopes: [1] },
      { scopes: "secret-value" },
      { subject: "secret-value" },
      { subject: "" },
      { unknown: "secret-value" },
      { serviceAccount: { ...(opts.serviceAccount as object), unknown: "secret-value" } },
    ]) {
      let failure: unknown;
      try {
        googleServiceAccountToken({ ...opts, ...override } as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConfigError);
      expect((failure as Error).message).not.toContain("secret-value");
    }
    const account = opts.serviceAccount as { clientEmail: string; privateKey: string };
    expect(
      typeof googleServiceAccountToken({
        ...opts,
        serviceAccount: JSON.stringify({
          type: "service_account",
          client_email: account.clientEmail,
          private_key: account.privateKey,
        }),
      }),
    ).toBe("function");
    expect(assertions).toHaveLength(0);
  });

  it("keeps key material and tokens out of configuration descriptions", async () => {
    const connector = remoteMcp("warehouse", {
      url: "https://bigquery.googleapis.com/mcp",
      authScope: "shared",
      auth: { type: "request", token: googleServiceAccountToken(options()) },
    });
    const app = createTestConnecta({ connectors: [connector] });
    try {
      const description = JSON.stringify(app.describeConfig());
      expect(description).toContain('"mode":"request"');
      expect(description).not.toMatch(/PRIVATE KEY|serviceAccount|minted-token/);
    } finally {
      await app.close();
    }
  });
});
