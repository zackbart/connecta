/** Isolated step-2 Stripe read universe; the #801 world keeps its original replies. */
export const STRIPE_STEP2_CUSTOMERS = [
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `cus_ada_${7 - i}`,
    object: "customer",
    email: "ada@example.com",
    created: 2000 - i,
  })),
  ...Array.from({ length: 130 }, (_, i) => ({
    id: `cus_step2_${String(i).padStart(3, "0")}`,
    object: "customer",
    email: `alice${i}@${i % 4 === 0 ? "example.org" : "example.net"}`,
    created: 1000 - i,
  })),
];
export const STRIPE_STEP2_DOMAIN_COUNT = STRIPE_STEP2_CUSTOMERS.filter((c) => c.email.endsWith("@example.org")).length;

export function stripeStep2Read(path: string, query: Record<string, string>): unknown | undefined {
  if (path === "/v1/account")
    return { id: "acct_eval", object: "account", country: "US", default_currency: "usd", livemode: false };
  if (path === "/v1/balance")
    return {
      object: "balance",
      livemode: false,
      available: [
        { amount: 12345, currency: "usd" },
        { amount: 1600, currency: "eur" },
      ],
      pending: [
        { amount: 600, currency: "usd" },
        { amount: 300, currency: "eur" },
      ],
    };
  if (path === "/v1/tax/settings")
    return {
      object: "tax.settings",
      status: "active",
      livemode: false,
      head_office: { address: { country: "US", state: "OR", city: "Portland", postal_code: "97205" } },
      defaults: { tax_behavior: "exclusive", tax_code: "txcd_10000000" },
    };
  if (path === "/v1/customers" || path === "/v1/customers/search") {
    let rows = STRIPE_STEP2_CUSTOMERS.filter((c) =>
      query.email ? c.email === query.email : query.query ? query.query.includes(c.email) : true,
    );
    if (query.starting_after) rows = rows.slice(rows.findIndex((c) => c.id === query.starting_after) + 1);
    if (query.ending_before)
      rows = rows.slice(
        0,
        rows.findIndex((c) => c.id === query.ending_before),
      );
    const size = Math.min(100, Math.max(1, Number(query.limit ?? 10)));
    const at = path.endsWith("/search") && query.page ? Number(query.page.replace(/^page_/, "")) : 0;
    const data = query.ending_before ? rows.slice(-size) : rows.slice(at, at + size);
    const has_more = query.ending_before ? rows.length > size : at + size < rows.length;
    return path.endsWith("/search")
      ? { object: "search_result", data, has_more, ...(has_more ? { next_page: `page_${at + size}` } : {}) }
      : { object: "list", data, has_more, url: path };
  }
  return undefined;
}
