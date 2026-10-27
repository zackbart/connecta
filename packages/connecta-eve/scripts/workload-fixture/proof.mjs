import assert from "node:assert/strict";
import { connectaConnection, connectaInstructions } from "@zackbart/connecta-eve";

const claims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

// Verify the signature independently: Connecta may reject claims before doing
// cryptography. A 401 alone cannot establish that a negative token was signed.
export async function verifySignature(token, owner, fetcher = fetch) {
  assert.match(owner, /^[A-Za-z0-9_-]+$/);
  const [header, body, signature] = token.split(".");
  const h = JSON.parse(Buffer.from(header, "base64url"));
  assert.equal(h.alg, "RS256");
  assert.ok(typeof h.kid === "string" && h.kid.length > 0 && h.kid.length <= 256);
  assert.equal(h.crit, undefined);
  assert.equal(h.b64, undefined);
  const issuer = claims(token).iss;
  assert.ok(issuer === "https://oidc.vercel.com" || issuer === `https://oidc.vercel.com/${owner}`);
  const response = await fetcher(`${issuer}/.well-known/jwks`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 65_536);
  const jwk = JSON.parse(text).keys.find((key) => key.kid === h.kid);
  assert.ok(jwk && !jwk.d);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  assert.equal(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(signature, "base64url"),
      Buffer.from(`${header}.${body}`),
    ),
    true,
  );
}

export async function proof({ origin, getToken, exchange, expected, fetcher = fetch, verify = verifySignature }) {
  assert.match(origin, /^https:\/\//);
  const current = await getToken();
  const original = claims(current);
  const claimChecks = {
    issuer: original.iss === `https://oidc.vercel.com/${expected.owner}`,
    audience: original.aud === `https://vercel.com/${expected.owner}`,
    subject: original.sub === `owner:${expected.owner}:project:${expected.projectName}:environment:production`,
    team: original.owner_id === expected.team,
    project: original.project_id === expected.project,
    environment: original.environment === "production",
  };
  assert.ok(Object.values(claimChecks).every(Boolean), "Workload differs from reviewed team-mode expectations");
  await verify(current, expected.owner);
  const instructions = connectaInstructions({ url: origin, pool: "assistant", getToken, fetch: fetcher });
  const memo = async (_key, fn) => fn({ idempotencyKey: "proof", abortSignal: new AbortController().signal });
  const guidance = await instructions.evaluate({ memo, turn: { id: "proof" } });
  assert.match(guidance?.content ?? "", /Disposable workload identity proof/);
  const rpc = async (
    variant,
    tokenResolver = getToken,
    path = "/agent/assistant",
    headerOnly = false,
    id = "proof",
  ) => {
    const connection = connectaConnection({
      url: `${origin}${path}`,
      description: "Disposable fixture",
      getToken: tokenResolver,
    });
    const { token } = await connection.auth.getToken();
    const response = await fetcher(`${connection.url}?variant=${variant}`, {
      method: "POST",
      headers: {
        [headerOnly ? "x-vercel-oidc-token" : "authorization"]: headerOnly ? token : `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "crm__read", arguments: { id } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    assert.ok(!body.includes(token), "Response disclosed credential");
    if (response.status === 200) {
      const payload = JSON.parse(
        body.trimStart().startsWith("{")
          ? body
          : body
              .split("\n")
              .find((line) => line.startsWith("data:"))
              .slice(5),
      );
      assert.ok(!payload.error && !payload.result.isError);
      assert.deepEqual(JSON.parse(payload.result.content[0].text), { id, fixture: 1040 });
    }
    return response.status;
  };
  const observations = [];
  for (const [name, path, headerOnly, status] of [
    ["positive", "/agent/assistant", false, 200],
    ["wrong-team", "/agent/assistant", false, 401],
    ["wrong-project", "/agent/assistant", false, 401],
    ["wrong-environment", "/agent/assistant", false, 401],
    ["header-only", "/agent/assistant", true, 401],
    ["unlisted-pool", "/agent/unlisted", false, 404],
    ["human-endpoint", "/mcp", false, 401],
  ]) {
    const variant = ["wrong-team", "wrong-project", "wrong-environment"].includes(name) ? name : "positive";
    const actual = await rpc(variant, () => current, path, headerOnly);
    assert.equal(actual, status);
    observations.push({
      name,
      status: actual,
      evidence: variant === "positive" ? "original-signed-token" : "signed-token-changed-receiver-binding",
    });
  }
  // Exactly one exchange; no arbitrary claim editing. Only audience violates an
  // admission rule. Exchange may also change iat and add act; report that fact.
  const audience = "https://tickets.example.com";
  const exchanged = await exchange({ token: current, audience, skipCache: true });
  await verify(exchanged, expected.owner);
  const other = claims(exchanged);
  for (const name of ["iss", "owner", "owner_id", "project", "project_id", "environment", "sub", "exp"])
    assert.equal(other[name], original[name]);
  assert.equal(other.aud, audience);
  assert.equal(other.external_sub, undefined);
  assert.ok(
    Number.isFinite(other.iat) &&
      other.iat <= Date.now() / 1000 + 30 &&
      other.exp > Date.now() / 1000 &&
      other.exp > other.iat,
  );
  assert.ok(
    other.nbf === undefined ||
      (Number.isFinite(other.nbf) && other.nbf <= Date.now() / 1000 + 30 && other.nbf < other.exp),
  );
  assert.equal(await rpc("positive", () => exchanged), 401);
  observations.push({
    name: "wrong-audience",
    status: 401,
    evidence: "exchanged-token-signature-independently-verified",
    changedClaims: Object.keys(other).filter((key) => JSON.stringify(other[key]) !== JSON.stringify(original[key])),
  });
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 12_000);
  try {
    const response = await fetcher(`${origin}/agent/assistant?cancel=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await getToken()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "crm__read", arguments: { id: "cancellation-probe" } },
      }),
      signal: cancellation.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let handshake = "";
    while (!handshake.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "Handler-start handshake ended early");
      handshake += decoder.decode(chunk.value, { stream: true });
      assert.ok(handshake.length <= 1_024);
    }
    assert.equal(handshake, ": handler-started\n\n");
    assert.equal(cancellation.signal.aborted, false, "Deadline is not a cancellation success");
    cancellation.abort();
    await reader.cancel().catch(() => {});
  } finally {
    clearTimeout(deadline);
  }
  const afterCancellation = await rpc("positive", getToken, "/agent/assistant", false, "fresh");
  assert.equal(afterCancellation, 200);
  const parallel = await Promise.all(
    Array.from({ length: 4 }, (_, i) => rpc("positive", getToken, "/agent/assistant", false, `race-${i}`)),
  );
  assert.deepEqual(parallel, [200, 200, 200, 200]);
  return {
    claimChecks,
    instructions: true,
    observations,
    concurrentRequests: 4,
    clientCancellation: true,
    afterCancellation,
    liveServerCancellationProven: false,
    issuerIsolation:
      "Not independently issuable: Vercel signs consistent team/global issuers only; local signed inconsistent-issuer control remains separate",
    deploymentScope: "team/project/environment, not deployment ID",
    live: false,
    tokenPersisted: false,
  };
}
