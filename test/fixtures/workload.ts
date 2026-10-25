// Loopback-only workload credentials: no real Vercel resource or credential.
export const workloadBinding = { team: "team_assistant", project: "prj_assistant" };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

export async function workloadFixture() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    jwks: { keys: [{ ...jwk, kid: "loopback" }] },
    async token(changes: Record<string, unknown> = {}) {
      const now = Math.floor(Date.now() / 1000);
      const input = `${json({ alg: "RS256", typ: "JWT", kid: "loopback" })}.${json({
        iss: "https://oidc.vercel.com/assistant", aud: "https://vercel.com/assistant",
        sub: "owner:assistant:project:assistant:environment:production", owner: "assistant", owner_id: workloadBinding.team,
        project: "assistant", project_id: workloadBinding.project, environment: "production", iat: now, nbf: now, exp: now + 7200, ...changes,
      })}`;
      return `${input}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input))))}`;
    },
  };
}
