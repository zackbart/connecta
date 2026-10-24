/** Deterministic Overflow v3 API, with fake-only credentials and stateful writes. */
import { serveFetch, type Served } from "../support/serve.js";
import type { CallRecord, Ledger } from "./service.js";

type Row = Record<string, any>;
const overflowId = (n: number) => n.toString(16).padStart(24, "0");
export const CAMP = overflowId(4001);
export const LOC = overflowId(5001);
export const DONOR = overflowId(1);
export const FIRST_GIFT = overflowId(6001);
export const SECOND_GIFT = overflowId(6002);
export const DEPOSIT = overflowId(7001);
export const GROUP = overflowId(8001);
export const DEVICE = overflowId(8101);
export const DESTINATION = overflowId(8201);
export const NEW_PHONE = "+15555550999";
const KEYS = { clientId: "evc_7d41c2a98f63b05e", apiKey: "evk_91c2e0b84d7a6f35" };

export function overflowState() {
  const donors: Row[] = Array.from({ length: 210 }, (_, i) => ({
    id: overflowId(i + 1),
    firstName: i === 0 ? "Alice" : "Bob",
    lastName: i === 0 ? "Example" : `Member${i}`,
    email: `person${i}@${i % 3 === 0 ? "care.example" : "example.org"}`,
    phone: `+1555${String(1000000 + i)}`,
    address: { line1: `${i + 1} Main St`, city: "Springfield", state: "IL", zip: "62701" },
    locationIds: [i % 2 ? overflowId(5002) : LOC],
    activeRecurringCount: i < 6 ? 1 : 0,
    totalContributionsCount: i < 6 ? 3 : 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  }));
  const campaigns: Row[] = [
    { id: CAMP, name: "Autumn Care", status: "active", isActive: true, isSubcampaign: false },
    { id: overflowId(4002), name: "Winter Care", status: "active", isActive: true, isSubcampaign: false },
  ];
  const locations: Row[] = [
    { id: LOC, name: "Main Campus", isDefaultLocation: true },
    { id: overflowId(5002), name: "North Campus", isDefaultLocation: false },
  ];
  const contributions: Row[] = Array.from({ length: 18 }, (_, i) => ({
    id: overflowId(6100 + i),
    type: "CASH",
    status: i % 4 === 0 ? "PROCESSING" : "PAID_OUT",
    amount: 1200 + i,
    frequency: i % 3 === 0 ? "monthly" : "one-time",
    donor: donors[i % 6],
    campaign: campaigns[i % 5 === 0 ? 1 : 0],
    locationId: i % 7 === 0 ? overflowId(5002) : LOC,
    contributionDate: `2026-10-${String(2 + i).padStart(2, "0")}T10:00:00.000Z`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  }));
  contributions.push(
    ...[FIRST_GIFT, SECOND_GIFT].map((id, i) => ({
      id,
      type: "CASH",
      status: "PAID_OUT",
      amount: 5000,
      frequency: "one-time",
      donor: donors[0],
      campaign: campaigns[0],
      locationId: LOC,
      contributionDate: `2026-10-22T12:0${i}:00.000Z`,
      createdAt: "2026-10-22T12:00:00.000Z",
      updatedAt: "2026-10-22T12:00:00.000Z",
    })),
  );
  const subscriptions: Row[] = donors.slice(0, 6).map((d, i) => ({
    id: overflowId(9000 + i),
    donorId: d.id,
    status: "active",
    amount: 25 + i * 5,
    frequency: "monthly",
    campaign: campaigns[0],
    locationId: LOC,
    nextPaymentDate: "2026-11-01",
    createdAt: "2025-01-01",
  }));
  const refunds: Row[] = [
    {
      id: overflowId(7101),
      contributionId: FIRST_GIFT,
      status: "SUCCEEDED",
      amountInCents: 1000,
      netValueInCents: 1000,
      depositId: DEPOSIT,
    },
  ];
  const chargebacks: Row[] = [
    {
      id: overflowId(7201),
      contributionId: FIRST_GIFT,
      status: "lost",
      amountInCents: 500,
      netValueInCents: -500,
      depositId: DEPOSIT,
    },
  ];
  const deposits: Row[] = [
    {
      id: DEPOSIT,
      status: "PAID",
      type: "AUTOMATED",
      amountInCents: 10000,
      arrivalAt: "2026-10-23T00:00:00.000Z",
      lineItems: [
        { type: "payment", grossValueInCents: 12000, grossFeeValueInCents: 500, referenceId: FIRST_GIFT },
        { type: "refund", grossValueInCents: -1000, grossFeeValueInCents: 0, referenceId: refunds[0]!.id },
        { type: "chargeback", grossValueInCents: -500, grossFeeValueInCents: 0, referenceId: chargebacks[0]!.id },
      ],
    },
    {
      id: overflowId(7002),
      status: "PAID",
      type: "AUTOMATED",
      amountInCents: 99999,
      arrivalAt: "2026-10-01T00:00:00.000Z",
      lineItems: [],
    },
  ];
  return {
    donors,
    campaigns,
    locations,
    contributions,
    subscriptions,
    refunds,
    chargebacks,
    deposits,
    refunded: [] as string[],
    updated: [] as string[],
  };
}
export type OverflowState = ReturnType<typeof overflowState>;

export class FakeOverflow {
  private served?: Served;
  readonly vendor = "overflow" as const;
  readonly credential = JSON.stringify(KEYS);
  constructor(
    readonly name: string,
    private readonly ledger: Ledger,
    readonly state: OverflowState,
    private readonly fault?: "update-500",
  ) {}
  get url() {
    if (!this.served) throw new Error("Overflow fake not started");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((request) => this.handle(request));
  }
  async stop() {
    await this.served?.close();
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname.replace(/^\/api\/v3/, "");
    const query: Row = {};
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      query[key] = values.length > 1 ? values : values[0];
    }
    const raw = request.method === "GET" ? "" : await request.text();
    const body = raw ? (JSON.parse(raw) as Row) : {};
    const authorized =
      request.headers.get("x-client-id") === KEYS.clientId && request.headers.get("x-api-key") === KEYS.apiKey;
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `${request.method} ${path}`,
      kind: request.method === "GET" ? "read" : "write",
      args: { method: request.method, path, query, body },
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.calls.push(record);
    this.ledger.requests.push({
      seq: record.seq,
      at: record.at,
      service: this.name,
      methods: [record.tool],
      authorized,
    });
    const reply = authorized
      ? this.dispatch(request.method, path, query, body)
      : { status: 401, value: { message: "Unauthorized" } };
    if (reply.status >= 400) {
      record.outcome = "tool_error";
      record.error = `HTTP ${reply.status}`;
    }
    const text = reply.status === 204 ? "" : JSON.stringify(reply.value);
    record.resultBytes = Buffer.byteLength(text);
    return new Response(reply.status === 204 ? null : text, {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }
  private dispatch(method: string, path: string, q: Row, body: Row): { status: number; value?: unknown } {
    const ok = (value: unknown) => ({ status: 200, value });
    const error = (status: number, message: string) => ({ status, value: { statusCode: status, message } });
    const one = (row: unknown) => (row ? ok({ data: row }) : error(404, "Resource not found"));
    const filtered = (rows: Row[]) =>
      rows.filter((r) => {
        const values = (key: string) => (q[`${key}[]`] === undefined ? [] : [q[`${key}[]`]].flat());
        return (
          (!q.campaignId || r.campaign?.id === q.campaignId) &&
          (!values("locationIds").length ||
            values("locationIds").includes(r.locationId) ||
            r.locationIds?.some((id: string) => values("locationIds").includes(id))) &&
          (!values("statusBucket").length ||
            values("statusBucket").includes(r.status === "PAID_OUT" ? "CONFIRMED" : "PENDING")) &&
          (!q.minimumInitiatedDate || r.contributionDate >= q.minimumInitiatedDate) &&
          (!q.maximumInitiatedDate || r.contributionDate <= q.maximumInitiatedDate) &&
          (!q.contributionId || r.contributionId === q.contributionId) &&
          (!q.donorId || r.donorId === q.donorId) &&
          (!q.search || String(r.name).toLowerCase().includes(String(q.search).toLowerCase()))
        );
      });
    const list = (rows: Row[]) => {
      const limit = Number(q.limit ?? 25),
        page = Number(q.page ?? 1);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(page) || page < 1)
        return error(400, "Invalid paging parameters");
      const selected = filtered(rows);
      return ok({ data: selected.slice((page - 1) * limit, page * limit), totalCount: selected.length });
    };
    const s = this.state;
    if (method === "GET") {
      if (path === "/donors") return list(s.donors);
      if (path.startsWith("/donors/")) return one(s.donors.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/contributions") return list(s.contributions);
      if (path.startsWith("/contributions/")) return one(s.contributions.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/subscriptions" || /^\/subscriptions\/[^/]+$/.test(path))
        return list(
          path === "/subscriptions" ? s.subscriptions : s.subscriptions.filter((r) => r.donorId === path.split("/")[2]),
        );
      if (/^\/subscriptions\/[^/]+\/[^/]+$/.test(path))
        return one(s.subscriptions.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/deposits") return list(s.deposits);
      if (path === `/deposits/${DEPOSIT}/summary`)
        return ok({
          data: {
            contributions: { count: 1, grossInCents: 12000, feesInCents: 500, totalInCents: 11500 },
            refunds: { count: 1, grossInCents: -1000, feesInCents: 0, totalInCents: -1000 },
            chargebacks: { count: 1, grossInCents: -500, feesInCents: 0, totalInCents: -500 },
            adjustments: {},
          },
        });
      if (path.startsWith("/deposits/")) return one(s.deposits.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/refunds") return list(s.refunds);
      if (path.startsWith("/refunds/")) return one(s.refunds.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/chargebacks") return list(s.chargebacks);
      if (path.startsWith("/chargebacks/")) return one(s.chargebacks.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/campaigns") return list(s.campaigns);
      if (path.startsWith("/campaigns/")) return one(s.campaigns.find((r) => r.id === path.split("/").at(-1)));
      if (path === "/locations") return list(s.locations);
      if (path.startsWith("/locations/")) return one(s.locations.find((r) => r.id === path.split("/").at(-1)));
      const group = { id: GROUP, name: "Welcome Desk", destinationId: DESTINATION, deviceIds: [DEVICE] };
      const destination = {
        id: DESTINATION,
        name: "Autumn Care Page",
        type: "web",
        url: "https://giving.example/autumn",
      };
      const device = { id: DEVICE, serialNumber: 47291, groupId: GROUP, group, currentDestination: destination };
      if (path === "/tap/groups") return list([group]);
      if (path === `/tap/groups/${GROUP}`) return one(group);
      if (path === "/tap/devices") return list([device]);
      if (path === `/tap/devices/${DEVICE}`) return one(device);
      if (path === "/tap/destinations") return list([destination]);
      if (path === `/tap/destinations/${DESTINATION}`) return one(destination);
      if (path === "/tap/events")
        return list([
          {
            id: overflowId(8301),
            createdAt: "2026-10-22",
            deviceId: DEVICE,
            device,
            groupId: GROUP,
            group,
            destinationId: DESTINATION,
            destination,
          },
        ]);
      if (path.startsWith("/payment-methods/"))
        return ok({ data: [{ id: overflowId(8401), type: "card", last4: "4242", isExpired: false }] });
    }
    if (method === "POST" && /^\/contributions\/[^/]+\/initiate-refund$/.test(path)) {
      const target = s.contributions.find((r) => r.id === path.split("/")[2]);
      if (!target) return error(404, "Contribution not found");
      if (target.status === "REFUNDED") return error(422, "Already refunded");
      target.status = "REFUNDED";
      s.refunded.push(target.id);
      s.refunds.push({
        id: overflowId(7300 + s.refunded.length),
        contributionId: target.id,
        status: "SUCCEEDED",
        amountInCents: 5000,
      });
      return { status: 202, value: "Refund initiated" };
    }
    if (method === "PATCH" && /^\/donors\/[^/]+$/.test(path)) {
      const donor = s.donors.find((r) => r.id === path.split("/")[2]);
      if (!donor) return error(404, "Donor not found");
      Object.assign(donor, body);
      s.updated.push(donor.id);
      if (this.fault === "update-500" && s.updated.length === 1) return error(500, "Upstream failed after commit");
      return { status: 204 };
    }
    return error(404, "Unknown route");
  }
}
