import { expect, it } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { probeRemoteAttempt } from "./fixtures/remote-mcp-attempts.js";

for (const challenge of ["421-closed", "421-open", "reset"])
  it(`INV-9: physical remote MCP attempts after ${challenge}`, { timeout: 30_000 }, async () => {
    // Deliberate native-fetch control, including Node's unsafe 421 replay.
    // The production owned Node sender is exercised in the Node-only suite.
    installOwnedTransport();
    const workerd = typeof WebSocketPair !== "undefined";
    for (const operation of ["write", "read", "resource"] as const) {
      const probe = await probeRemoteAttempt(challenge, operation);
      expect(probe.received, operation).toHaveLength(challenge === "421-open" && !workerd ? 2 : 1);
      expect(new Set(probe.received).size).toBe(1);
      if (challenge === "421-open" && !workerd) expect(probe.error).toBeUndefined();
      else expect(probe.error).toBeDefined();
      if (operation === "write" && probe.error)
        expect(probe.error).toMatchObject({
          retryable: false,
          ...(workerd && challenge.startsWith("421") ? {} : { writeOutcome: "unknown" }),
        });
    }
  });
