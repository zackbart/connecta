/** Independent fake People state, a delegated token mint and a physical HTTP ledger; no Google account. */
import { generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { serveFetch, type Served } from "../../../../eval/support/serve.js";
import type { Ledger } from "../../../../eval/fakes/service.js";
import { routeFakeVendor } from "../../../../eval/fakes/transport.js";
import type { ProviderFake } from "../../../../eval/support/provider-eval.js";

type Row = Record<string, any>;

/** The fixed Workspace user every call acts as. */
const PEOPLE_SUBJECT = "alice@example.com";
/** Values the review withholds or the default sensitive-field choice drops; none may reach an agent. */
export const PEOPLE_PRIVATE = {
  birthday: "1987-04-19",
  note: "people-private-note-7c1e",
  photo: "https://lh3.googleusercontent.com/people-private-photo-4d2a",
  clientData: "people-client-data-91fb",
} as const;

const SCOPES = [
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/user.emails.read",
  "https://www.googleapis.com/auth/user.phonenumbers.read",
  "https://www.googleapis.com/auth/user.addresses.read",
  "https://www.googleapis.com/auth/user.birthday.read",
  "https://www.googleapis.com/auth/user.organization.read",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const entry = (value: Row, primary = true) => ({ ...value, metadata: { primary, source: { type: "CONTACT" } } });

function peopleState() {
  return {
    contacts: [
      {
        resourceName: "people/c1001",
        etag: "%EgcBAgMEBQYH",
        names: [entry({ displayName: "Bob Example", givenName: "Bob", familyName: "Example" })],
        emailAddresses: [entry({ value: "bob@example.com", type: "work" })],
        phoneNumbers: [entry({ value: "+1 555 0101", type: "mobile" })],
        birthdays: [entry({ date: { year: 1987, month: 4, day: 19 }, text: PEOPLE_PRIVATE.birthday })],
        biographies: [entry({ value: PEOPLE_PRIVATE.note, contentType: "TEXT_PLAIN" })],
        photos: [entry({ url: PEOPLE_PRIVATE.photo })],
        clientData: [entry({ key: "crm", value: PEOPLE_PRIVATE.clientData })],
        memberships: [entry({ contactGroupMembership: { contactGroupResourceName: "contactGroups/myContacts" } })],
      },
    ] as Row[],
    otherContacts: [
      {
        resourceName: "otherContacts/c2002",
        etag: "%EgcCAwQFBgcI",
        names: [entry({ displayName: "Carol Other", givenName: "Carol", familyName: "Other" })],
        emailAddresses: [entry({ value: "carol@example.net" })],
        photos: [entry({ url: PEOPLE_PRIVATE.photo })],
      },
    ] as Row[],
    directory: [
      {
        resourceName: "people/d3003",
        etag: "%EgcDBAUGBwgJ",
        names: [entry({ displayName: "Dana Coworker", givenName: "Dana", familyName: "Coworker" })],
        emailAddresses: [entry({ value: "dana@example.com", type: "work" })],
        organizations: [entry({ name: "Example Org", title: "Planner" })],
        photos: [entry({ url: PEOPLE_PRIVATE.photo })],
      },
    ] as Row[],
    groups: [
      { resourceName: "contactGroups/myContacts", etag: "g1", name: "myContacts", groupType: "SYSTEM_CONTACT_GROUP" },
      { resourceName: "contactGroups/7a1b2c", etag: "g2", name: "Planning", groupType: "USER_CONTACT_GROUP" },
    ] as Row[],
    /** Group resource name → member contact resource names. */
    members: { "contactGroups/myContacts": ["people/c1001"], "contactGroups/7a1b2c": [] } as Record<string, string[]>,
    /** Search endpoints whose cache a warm-up (empty query) refreshed since the last write. */
    warmed: [] as string[],
    mints: [] as { subject: string; scopes: string[] }[],
  };
}

/** Word-prefix match over names and emails, as Google's contact search matches. */
function matches(person: Row, query: string): boolean {
  const words = [
    ...(person.names ?? []).flatMap((n: Row) => String(n.displayName ?? "").split(/\s+/)),
    ...(person.emailAddresses ?? []).map((e: Row) => String(e.value ?? "")),
  ].map((word) => word.toLowerCase());
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => words.some((word) => word.startsWith(part)));
}

/** Only the requested mask's fields, as Google returns them. */
function masked(person: Row, mask: string | null): Row {
  const fields = new Set((mask ?? "").split(",").filter(Boolean));
  return Object.fromEntries(
    Object.entries(person).filter(([key]) => key === "resourceName" || key === "etag" || fields.has(key)),
  );
}

export class FakePeople {
  readonly state = peopleState();
  private server?: Served;
  private release: (() => void) | undefined;
  private publicKey!: KeyObject;
  private readonly tokens = new Set<string>();
  serviceAccount!: { clientEmail: string; privateKey: string };
  constructor(private readonly ledger: Ledger) {}
  get url() {
    if (!this.server) throw new Error("People fake is not started");
    return this.server.url;
  }
  async start() {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.publicKey = key.publicKey;
    this.serviceAccount = {
      clientEmail: `people-${randomBytes(8).toString("hex")}@fixture.iam.gserviceaccount.com`,
      privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    this.server = await serveFetch(async (request) => this.fetch(request));
    const issuer = `iss:${this.serviceAccount.clientEmail}`;
    this.release = routeFakeVendor({
      hosts: ["people.googleapis.com", "oauth2.googleapis.com"],
      owns: (credential) => credential === issuer || this.tokens.has(credential),
      target: this.url,
    });
  }
  async stop() {
    this.release?.();
    this.release = undefined;
    this.tokens.clear();
    await this.server?.close();
  }

  private async mint(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const [header, payload, signature] = (form.get("assertion") ?? "").split(".");
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      this.publicKey,
      Buffer.from(signature ?? "", "base64url"),
    );
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Row;
    const scopes = String(claims.scope ?? "").split(" ");
    if (
      !signed ||
      form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
      claims.iss !== this.serviceAccount.clientEmail ||
      claims.sub !== PEOPLE_SUBJECT ||
      [...scopes].sort().join(" ") !== [...SCOPES].sort().join(" ")
    )
      return Response.json({ error: "unauthorized_client" }, { status: 401 });
    this.state.mints.push({ subject: claims.sub, scopes });
    const token = `ya29.people-${randomBytes(12).toString("hex")}`;
    this.tokens.add(token);
    return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/token") return this.mint(request);
    const authorized = this.tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    const raw = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    const body: Row = raw ? JSON.parse(raw) : {};
    const path = decodeURIComponent(url.pathname.replace(/^\/v1/, ""));
    const query = Object.fromEntries(
      [...new Set(url.searchParams.keys())].map((key) => [
        key,
        url.searchParams.getAll(key).length > 1 ? url.searchParams.getAll(key) : url.searchParams.get(key),
      ]),
    );
    const record = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: "people",
      tool: `${request.method} ${path}`,
      args: { method: request.method, path, query, body, returned: undefined as unknown },
      kind: request.method === "GET" ? ("read" as const) : ("write" as const),
      outcome: "ok" as "ok" | "tool_error",
      resultBytes: 0,
    };
    this.ledger.calls.push(record);
    this.ledger.requests.push({
      seq: record.seq,
      at: record.at,
      service: "people",
      methods: [request.method],
      authorized,
    });
    const send = (value: unknown, status = 200) => {
      if (status >= 400) record.outcome = "tool_error";
      const text = JSON.stringify(value);
      record.resultBytes = text.length;
      record.args.returned = structuredClone(value);
      return new Response(text, { status, headers: { "Content-Type": "application/json" } });
    };
    const fail = (status: number, message: string, reason: string) =>
      send({ error: { code: status, message, status: reason } }, status);
    if (!authorized) return fail(401, "Request had invalid authentication credentials.", "UNAUTHENTICATED");
    const s = this.state;
    const search = (endpoint: string, rows: Row[], mask: string | null) => {
      const text = String(query.query ?? "");
      if (!text) {
        if (!s.warmed.includes(endpoint)) s.warmed.push(endpoint);
        return send({});
      }
      // Google's search cache is stale until a warm-up request refreshes it.
      if (!s.warmed.includes(endpoint)) return send({});
      return send({
        results: rows.filter((p) => matches(p, text)).map((person) => ({ person: masked(person, mask) })),
      });
    };
    if (request.method === "GET" && path === "/people:searchContacts")
      return search(path, s.contacts, query.readMask as string);
    if (request.method === "GET" && path === "/otherContacts:search")
      return search(path, s.otherContacts, query.readMask as string);
    if (request.method === "GET" && path === "/people:searchDirectoryPeople") {
      const rows = s.directory.filter((p) => matches(p, String(query.query ?? "")));
      return send({ people: rows.map((p) => masked(p, query.readMask as string)), totalSize: rows.length });
    }
    if (request.method === "GET" && path === "/people/me/connections")
      return send({ connections: s.contacts.map((p) => masked(p, query.personFields as string)) });
    if (request.method === "GET" && path === "/contactGroups")
      return send({
        contactGroups: s.groups.map((g) => ({ ...g, memberCount: s.members[g.resourceName]?.length ?? 0 })),
      });
    const group = /^\/contactGroups\/([^/:]+)(\/members:modify)?$/.exec(path);
    if (group) {
      const resourceName = `contactGroups/${group[1]}`;
      const found = s.groups.find((g) => g.resourceName === resourceName);
      if (!found) return fail(404, "Requested entity was not found.", "NOT_FOUND");
      if (request.method === "GET" && !group[2]) {
        const members = s.members[resourceName] ?? [];
        return send({
          ...found,
          memberCount: members.length,
          memberResourceNames: members.slice(0, Number(query.maxMembers ?? 0)),
        });
      }
      if (request.method === "POST" && group[2]) {
        const add: string[] = body.resourceNamesToAdd ?? [];
        const notFound = add.filter((name) => !s.contacts.some((p) => p.resourceName === name));
        const members = (s.members[resourceName] ??= []);
        for (const name of add) if (!notFound.includes(name) && !members.includes(name)) members.push(name);
        return send(notFound.length ? { notFoundResourceNames: notFound } : {});
      }
    }
    const copy = /^\/otherContacts\/([^/:]+):copyOtherContactToMyContactsGroup$/.exec(path);
    if (request.method === "POST" && copy) {
      const other = s.otherContacts.find((p) => p.resourceName === `otherContacts/${copy[1]}`);
      if (!other) return fail(404, "Requested entity was not found.", "NOT_FOUND");
      const created: Row = {
        ...masked(other, String(body.copyMask ?? "")),
        resourceName: `people/c${4000 + s.contacts.length}`,
        etag: `%new${s.contacts.length}`,
        memberships: [entry({ contactGroupMembership: { contactGroupResourceName: "contactGroups/myContacts" } })],
      };
      s.contacts.push(created);
      s.members["contactGroups/myContacts"]!.push(created.resourceName);
      // A write leaves the search cache stale until the next warm-up.
      s.warmed = [];
      return send(masked(created, String(body.readMask ?? "")));
    }
    const person = /^\/people\/([^/:]+)$/.exec(path);
    if (request.method === "GET" && person) {
      const found = [...s.contacts, ...s.directory].find((p) => p.resourceName === `people/${person[1]}`);
      return found
        ? send(masked(found, query.personFields as string))
        : fail(404, "Requested entity was not found.", "NOT_FOUND");
    }
    return fail(404, "Unregistered People fake route.", "NOT_FOUND");
  }
}

export const evalFake: ProviderFake<FakePeople> = {
  create: (ledger) => new FakePeople(ledger),
  specs: (fake) => [
    {
      id: "people",
      title: "Google People",
      description: "Resolve meeting attendees across contacts, other contacts and the directory",
      url: fake.url,
      // The deployment's delegated service account, as a deployment secret; never an agent's.
      credential: {
        label: "Service account key",
        value: JSON.stringify({
          type: "service_account",
          client_email: fake.serviceAccount.clientEmail,
          private_key: fake.serviceAccount.privateKey,
        }),
      },
    },
  ],
  saved: (state) =>
    Array.isArray(state.contacts) &&
    Array.isArray(state.otherContacts) &&
    Array.isArray(state.directory) &&
    Array.isArray(state.groups) &&
    !!state.members &&
    Array.isArray(state.mints),
};
