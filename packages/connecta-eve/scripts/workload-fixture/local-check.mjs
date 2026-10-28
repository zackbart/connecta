// Same ephemeral RSA/JWKS substitution as the original #1040 local runner.
// These signatures are local controls, never evidence of Vercel issuance.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { exchangeVercelOidcToken } from "@vercel/oidc";
import { endpoint } from "./endpoint.mjs";
import { handle } from "./handler.mjs";

const expected = { team: "team_assistant", project: "prj_assistant", owner: "assistant", projectName: "assistant" };
const key = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "fixture", alg: "RS256" };
const encode = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
async function token(changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ iss: "https://oidc.vercel.com/assistant", aud: "https://vercel.com/assistant", sub: "owner:assistant:project:assistant:environment:production", owner: "assistant", owner_id: expected.team, project: "assistant", project_id: expected.project, environment: "production", iat: now, nbf: now, exp: now + 3600, ...changes })}`;
  return `${body}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, Buffer.from(body))).toString("base64url")}`;
}
const originalFetch = globalThis.fetch;
const reads = [];
const receipts = [];
const retained = [];
let exchanges = 0;
let keyFetches = 0;
const settings = {
  origin: "https://proof.test",
  expected,
  runId: "local-proof",
  runKey: "local-only",
  deploymentId: "local",
  getToken: () => token(),
  exchange: exchangeVercelOidcToken,
  retain: (work) => retained.push(work),
  emit: (receipt) => receipts.push(receipt),
  onRead: (id) => reads.push(id),
};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (
    ["https://oidc.vercel.com/.well-known/jwks", "https://oidc.vercel.com/assistant/.well-known/jwks"].includes(
      request.url,
    )
  ) {
    keyFetches++;
    assert.equal(request.redirect, "manual");
    return Response.json({ keys: [jwk] });
  }
  if (request.url === "https://oidc.vercel.com/~token") {
    const body = await request.json();
    assert.equal(body.aud, "https://tickets.example.com");
    const original = JSON.parse(Buffer.from(body.token.split(".")[1], "base64url"));
    exchanges++;
    return Response.json({
      token: await token({ ...original, aud: body.aud, act: { aud: original.aud, iat: original.iat } }),
    });
  }
  assert.equal(new URL(request.url).origin, settings.origin);
  const response = await handle(request, settings);
  if (new URL(request.url).searchParams.get("cancel") === "1" && response.ok) {
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream({
        async start(controller) {
          const first = await reader.read();
          controller.enqueue(first.value.slice(0, 3));
          controller.enqueue(first.value.slice(3));
        },
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        },
        cancel() {
          return reader.cancel();
        },
      }),
      { status: response.status, headers: response.headers },
    );
  }
  return response;
};
try {
  const response = await fetch(`${settings.origin}/proof`, {
    method: "POST",
    headers: { "x-proof-key": settings.runKey },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  await Promise.all(retained);
  assert.equal(result.live, false);
  assert.equal(result.invocations, 16);
  assert.equal(exchanges, 1);
  assert.equal(result.observations.length, 8);
  assert.equal(reads.length, 7);
  assert.deepEqual(reads.filter((id) => id.startsWith("race-")).sort(), ["race-0", "race-1", "race-2", "race-3"]);
  assert.deepEqual(
    receipts.map(({ stage, signalAborted }) => ({ stage, signalAborted })),
    [
      { stage: "handler-started", signalAborted: false },
      { stage: "handler-cancelled", signalAborted: true },
      { stage: "app-closed", signalAborted: true },
    ],
  );
  assert.ok(receipts.every((r) => r.runId === settings.runId && r.deploymentId === "local"));
  assert.deepEqual(
    receipts.map((r) => r.sequence),
    [1, 2, 3],
  );
  const validlySignedLocalControls = [];
  const app = endpoint({ team: expected.team, project: expected.project });
  try {
    for (const changes of [
      { aud: "https://vercel.com/wrong" },
      { iss: "https://oidc.vercel.com/wrong" },
      { sub: "owner:assistant:project:wrong:environment:production" },
      { owner_id: "team_wrong" },
      { project_id: "prj_wrong" },
      { external_sub: "external" },
      { iat: null },
      { exp: null },
      { nbf: Math.floor(Date.now() / 1000) + 120 },
    ]) {
      const value = await token(changes);
      // Prove each negative's signature without trusting endpoint execution order.
      const [header, body, signature] = value.split(".");
      assert.equal(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key.publicKey,
          Buffer.from(signature, "base64url"),
          Buffer.from(`${header}.${body}`),
        ),
        true,
      );
      const refused = await app.fetch(
        new Request(`${settings.origin}/agent/assistant`, {
          method: "POST",
          headers: { authorization: `Bearer ${value}` },
          body: "{}",
        }),
      );
      assert.equal(refused.status, 401);
      await refused.arrayBuffer();
      validlySignedLocalControls.push({
        claim: Object.keys(changes)[0],
        status: refused.status,
        signature: "ephemeral-local-RSA",
      });
    }
  } finally {
    await app.close();
  }
  const report = {
    ...result,
    validlySignedLocalControls,
    receipts,
    handlerReads: reads.length,
    keyFetches,
    exchanges,
    runtime: process.version,
    eve: "0.86.0",
    oidc: "4.0.3",
    trust: "Local RSA, intercepted JWKS/exchange and in-process Request.signal; no live platform or paid model",
  };
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized));
  await writeFile("local-results.json", serialized + "\n");
  console.log(
    "Installed-package local workload controls passed; server cancellation receipts retained. No live resources or tokens.",
  );
} finally {
  globalThis.fetch = originalFetch;
}
