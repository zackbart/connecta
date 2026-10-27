/** Eval-only redirect. Product URLs and OAuth options remain fixed and unmodified. */
import { quickbooks } from "@zackbart/connecta/providers/quickbooks";
import type { InboundAuth } from "@zackbart/connecta";

export const QB_COMPANIES = { alice: "111111", bob: "222222" } as const;
export const QB_CLIENT = "eval-qb-client";
export const QB_SECRET = "eval-qb-client-secret";
const QB_HOSTS = [
  "sandbox-quickbooks.api.intuit.com",
  "quickbooks.api.intuit.com",
  "oauth.platform.intuit.com",
  "developer.api.intuit.com",
];

export function quickbooksConnectors(writes = false) {
  const owners = Object.entries(QB_COMPANIES).map(([owner, realmId]) =>
    quickbooks(`qb_${owner}`, {
      purpose: `${owner}'s accounting`,
      realmId,
      ...(writes ? { readOnly: false } : {}),
      ...(owner === "bob" ? { authScope: "personal" as const } : {}),
      environment: owner === "alice" ? "sandbox" : "production",
      clientId: QB_CLIENT,
      clientSecret: QB_SECRET,
    }),
  );
  return writes
    ? [
        ...owners,
        ...([1, 4] as const).map((maxCalls) =>
          quickbooks(`qb_budget_${maxCalls}`, {
            purpose: "bounded invoice admission",
            realmId: QB_COMPANIES.alice,
            environment: "sandbox",
            clientId: QB_CLIENT,
            clientSecret: QB_SECRET,
            readOnly: false,
            callAdmission: {
              rules: [{ maxConcurrency: 1, budget: { kind: "rolling-window", maxCalls, windowMs: 60000 } }],
            },
          }),
        ),
        ...[undefined, true].map((readOnly, index) =>
          quickbooks(`qb_readonly_${index}`, {
            purpose: "read-only refusal probe",
            realmId: QB_COMPANIES.alice,
            environment: "sandbox",
            clientId: QB_CLIENT,
            clientSecret: QB_SECRET,
            ...(readOnly === undefined ? {} : { readOnly }),
          }),
        ),
      ]
    : owners;
}
export const quickbooksAuth: InboundAuth = {
  kind: "clerk",
  interactiveOperator: true,
  activityActorNamespace: "https://eval-directory.test",
  uiAuth: { kind: "clerk", publishableKey: "pk_test_fake", frontendApiUrl: "https://eval-directory.test" },
  recognizesCredential: (r) => /^Bearer eval-(alice|bob)$/.test(r.headers.get("authorization") ?? ""),
  authorize: (r) => {
    const userId = /^Bearer eval-(alice|bob)$/.exec(r.headers.get("authorization") ?? "")?.[1];
    return userId ? { ok: true, userId } : { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  },
};
export const quickbooksPools = (writes = false) => ({
  eval: {
    tools: ["qb_alice", ...(writes ? ["qb_readonly_0", "qb_readonly_1", "qb_budget_1", "qb_budget_4"] : [])],
    members: ["agent:eval-machine"],
  },
  readonly: { tools: ["qb_alice"], members: ["agent:eval-machine", "alice"], readOnly: true },
  bob: { tools: ["qb_bob"], members: ["bob"] },
});

/** All Intuit traffic fails closed onto a local fake, including unexpected credentials. */
export function interceptQuickBooks(target: string): () => void {
  const forward = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (QB_HOSTS.includes(url.hostname)) request.headers.set("x-eval-vendor-origin", url.origin);
    return QB_HOSTS.includes(url.hostname)
      ? forward(new Request(`${target}${url.pathname}${url.search}`, request))
      : forward(request);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = forward;
  };
}
