import { describe, expect, it } from "vitest";
import { authorize } from "../src/routes/shared.js";
import type { InboundAuth } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";

const BASE = "https://connecta.example";
const CHALLENGE = 'Bearer resource_metadata="https://idp.example/meta"';
const metadataAnswers = [
  ["204", () => new Response(null, { status: 204 })],
  ["redirect", () => Response.redirect("https://idp.example/meta", 302)],
  ["JSON body", () => Response.json({ resource: BASE })],
] as const;
const credentials = ["Bearer refused", "Basic malformed", "Bearer cta_refused"];

function adapter(metadata: () => Response): InboundAuth {
  return {
    kind: "custom",
    activityActorNamespace: "custom",
    interactiveOperator: true,
    handleMetadata: (request) =>
      new URL(request.url).pathname.startsWith("/.well-known/oauth-protected-resource") ? metadata() : null,
    challenge: () => CHALLENGE,
    authorize: () => ({ ok: false, response: new Response(null, { status: 401 }) }),
  };
}

describe.each(metadataAnswers)("metadata-owned challenge with %s metadata", (_name, metadata) => {
  it.each(credentials)("INV-4: direct authorization retains the challenge for %s", async (authorization) => {
    const result = await authorize(new Request(`${BASE}/mcp`, { headers: { authorization } }), BASE, [
      adapter(metadata),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("www-authenticate")).toBe(CHALLENGE);
    }
  });

  it.each(credentials)("INV-4: the real /mcp route answers 401 with the challenge for %s", async (authorization) => {
    const app = createTestConnecta({
      auth: [adapter(metadata)],
      connectors: [],
      maintainers: [{ namespace: "custom", id: "alice" }],
      publicUrl: BASE,
      logger: "silent",
    });
    try {
      const response = await app.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: { authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
