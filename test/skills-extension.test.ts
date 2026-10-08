import { expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { SkillsRegistry, downstreamSkillUri } from "../src/skills.js";
import { sentSecretsFor } from "../src/sent-secrets.js";
import { callerOf } from "../src/connector-caller.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext } from "../src/types.js";

const BASE = "https://connecta.test";
const URI = "skill://vendor/review/SKILL.md";
const TEXT = "---\nname: review\ndescription: Review changes.\n---\n\nReview bytes.\r\n";
const DIGEST = "sha256:" + "a".repeat(64);
function guided(id: string, required = false): Connector {
  return api(id, { usageGuide: { content: `# ${id}\n\nRead ${id}.\n`, required }, tools: [] });
}
function downstream(id = "remote", overrides: Partial<NonNullable<Connector["downstreamSkills"]>> = {}): Connector {
  return { id, listTools: async () => [], callTool: async () => null,
    downstreamSkills: {
      list: async () => [{ uri: URI, frontmatter: { name: "review", description: "Review changes.", custom: [1, 2] },
        resources: [{ uri: URI, digest: DIGEST, size: new TextEncoder().encode(TEXT).length }] }],
      read: async uri => [{ uri, mimeType: "text/markdown", text: TEXT }],
      ...overrides,
    } };
}
async function rpc(c: ReturnType<typeof createTestConnecta>, method: string, params: Record<string, unknown> = {}, path = "/mcp", token?: string) {
  const response = await c.fetch(new Request(BASE + path, { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": method, "MCP-Protocol-Version": "2026-07-28",
    ...(method === "resources/read" ? { "Mcp-Name": String(params.uri) } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "1" },
  } } }) }));
  return response.json() as Promise<any>;
}

it("INV-4: prioritizes usage and required guides within five-entry skill pages", async () => {
  const registry = new SkillsRegistry(makeRegistry([guided("z"), guided("required", true), ...["a", "b", "c", "d"].map(id => guided(id))]), BASE);
  const first = await registry.list();
  expect(first.cacheScope).toBe("private");
  expect(first.skills.map(s => s.frontmatter.name)).toEqual(["usage", "required", "a", "b", "c"]);
  expect(first.nextCursor).toBeTruthy();
  const second = await registry.list(first.nextCursor);
  expect(second.skills.map(s => s.frontmatter.name)).toEqual(["d", "z", "investigate"]);
  await expect(registry.list("forged")).rejects.toMatchObject({ code: "invalid_args" });
});

it("INV-4 INV-5: isolates skill disclosure across principals, pools and tool-only grants", async () => {
  const touched: string[] = [];
  const remote = downstream("remote", { list: async ctx => {
    const caller = callerOf(ctx)!;
    touched.push(`${caller.identity.principal?.id}:${caller.pool ?? "all"}`);
    const entry = (await downstream().downstreamSkills!.list(ctx))[0]!;
    return [{ ...entry, frontmatter: { ...entry.frontmatter, owner: caller.identity.principal?.id } }];
  } });
  remote.usageGuide = "# Remote\n\nRemote conventions.\n";
  const c = createTestConnecta({ connectors: [remote, guided("other")], logger: silentLogger,
    auth: { kind: "clerk", activityActorNamespace: "https://clerk.skills.test", authorize: request => { const id = request.headers.get("Authorization")?.slice(7); return id ? { ok: true, userId: id } : { ok: false, response: new Response(null, { status: 401 }) }; } },
    identity: { connectorAccess: ({ principal }) => principal?.id === "alice" ? "all" : ["other"] },
    pools: { remote: { tools: ["remote"], grant: () => true }, narrow: { tools: ["remote.read"], grant: () => true } },
  });
  const alice = await rpc(c, "skills/list", {}, "/mcp/remote", "alice");
  expect(JSON.stringify(alice.result)).toContain('"owner":"alice"');
  expect(JSON.stringify(alice.result)).not.toContain("connectors/other");
  const bob = await rpc(c, "skills/list", {}, "/mcp", "bob");
  expect(JSON.stringify(bob.result)).not.toContain("downstream/remote");
  expect(JSON.stringify(bob.result)).not.toContain("connectors/remote");
  const narrow = await rpc(c, "skills/list", {}, "/mcp/narrow", "alice");
  expect(JSON.stringify(narrow.result)).toContain("connectors/remote");
  expect(JSON.stringify(narrow.result)).not.toContain("downstream/remote");
  expect(touched).toEqual(["alice:remote"]);
  await c.close();
});

it("INV-5: preserves uncredentialed skill examples and redacts credentials inside binary files", async () => {
  const secret = "credential-sent-for-skills-only";
  const examples = TEXT + "Authorization: example header\nCookie: example cookie\n";
  const file = "skill://vendor/review/reference.bin";
  const binary = "\u0000\u00ff" + secret + "\u0000";
  const remote = downstream("remote", {
    list: async ctx => [{ ...(await downstream().downstreamSkills!.list(ctx))[0]!, resources: [
      { uri: URI, digest: DIGEST, size: new TextEncoder().encode(examples).length },
      { uri: file, digest: DIGEST, size: binary.length },
    ] }],
    read: async (uri, ctx) => { sentSecretsFor(ctx).secret(secret); return uri === URI ? [{ uri, text: examples }] : [{ uri, blob: btoa(binary) }]; },
  });
  const c = createTestConnecta({ connectors: [remote], logger: silentLogger });
  const text = await rpc(c, "resources/read", { uri: downstreamSkillUri("remote", URI) });
  expect(text.result.contents[0].text).toBe(examples);
  const blob = await rpc(c, "resources/read", { uri: downstreamSkillUri("remote", file) });
  expect(atob(blob.result.contents[0].blob)).toBe("\u0000\u00ff[redacted]\u0000");
  const meta = await createMetaTools(makeRegistry([remote]), BASE).skills({ name: downstreamSkillUri("remote", URI) });
  expect(meta.content[0]?.text).toBe(examples);
  await c.close();
});

it("INV-5 INV-8: keeps blob credential collisions validly encoded through HTTP serialization", async () => {
  const file = "skill://vendor/review/reference.bin";
  for (const secret of [btoa("abcdefgh"), "AAAAAAAA"]) {
    const bytes = secret === "AAAAAAAA" ? "\u0000".repeat(12) : "abcdefgh";
    const remote = downstream("remote", {
      list: async ctx => [{ ...(await downstream().downstreamSkills!.list(ctx))[0]!, resources: [
        { uri: URI, digest: DIGEST, size: TEXT.length }, { uri: file, digest: DIGEST, size: bytes.length },
      ] }],
      read: async (uri, ctx) => { sentSecretsFor(ctx).secret(secret); return [{ uri, blob: btoa(bytes) }]; },
    });
    const c = createTestConnecta({ connectors: [remote], logger: silentLogger });
    try {
      const read = await rpc(c, "resources/read", { uri: downstreamSkillUri("remote", file) });
      expect(read.error).toBeUndefined();
      expect(atob(read.result.contents[0].blob)).toBe("[redacted]");
      expect(JSON.stringify(read)).not.toContain(secret);
    } finally { await c.close(); }
  }
});

it.each([1, 2])("INV-5: redacts credentials behind %i JSON escape layers in binary supporting files", async layers => {
  const secret = "escaped-blob-skills-credential";
  const escaped = secret.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const bytes = layers === 1 ? `{"echo":"${escaped}"}` : JSON.stringify({ echo: escaped });
  const file = "skill://vendor/review/reference.json";
  const remote = downstream("remote", {
    list: async ctx => [{ ...(await downstream().downstreamSkills!.list(ctx))[0]!, resources: [
      { uri: URI, digest: DIGEST, size: TEXT.length }, { uri: file, digest: DIGEST, size: bytes.length },
    ] }],
    read: async (uri, ctx) => { sentSecretsFor(ctx).secret(secret); return [{ uri, blob: btoa(bytes) }]; },
  });
  const c = createTestConnecta({ connectors: [remote], logger: silentLogger });
  try {
    const read = await rpc(c, "resources/read", { uri: downstreamSkillUri("remote", file) });
    const decoded = atob(read.result.contents[0].blob);
    expect(JSON.parse(decoded).echo).toBe("[redacted]");
    expect(decoded).not.toContain("\\u0065");
  } finally { await c.close(); }
});

it.each(["\u0000", "\\u0000"])("INV-5 INV-8: serves authenticated escaped skill bytes with bounded redaction scratch space %j", async padding => {
  const secret = "bounded-skills-redaction-credential";
  const text = TEXT + padding.repeat(1024 * 1024) + secret;
  const remote = downstream("remote", {
    list: async ctx => [{ ...(await downstream().downstreamSkills!.list(ctx))[0]!, resources: "dynamic" }],
    read: async (uri, ctx) => { sentSecretsFor(ctx).secret(secret); return [{ uri, text }]; },
  });
  const c = createTestConnecta({ connectors: [remote], logger: silentLogger });
  try {
    const read = await rpc(c, "resources/read", { uri: downstreamSkillUri("remote", URI) });
    expect(read.error).toBeUndefined();
    expect(read.result.contents[0].text).toBe(TEXT + padding.repeat(1024 * 1024) + "[redacted]");
  } finally { await c.close(); }
}, 30_000);

it("INV-4 INV-5: fetches personal downstream skills with each principal's credential partition", async () => {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
  await vault.set("remote", "alice-downstream-skills-token", "operator", "alice");
  await vault.set("remote", "bob-downstream-skills-token", "operator", "bob");
  const fetched: string[] = [];
  const remote = downstream("remote", {
    list: async ctx => { const token = (await ctx.credential!.get())!; fetched.push(token); return downstream().downstreamSkills!.list(ctx); },
    read: async (uri, ctx) => [{ uri, text: TEXT + ((await ctx.credential!.get())!.startsWith("alice") ? "alice guide" : "bob guide") }],
  });
  remote.authScope = "personal";
  remote.credential = { label: "Token" };
  const root = makeRegistry([remote], { storage, credentialVault: vault });
  const uri = downstreamSkillUri("remote", URI);
  for (const principalKey of ["alice", "bob", "alice"]) {
    const view = root.scoped({ connectorIds: ["remote"], principalKey });
    const registry = new SkillsRegistry(view, BASE);
    expect((await registry.read(uri)).contents[0]?.text).toBe(TEXT + `${principalKey} guide`);
  }
  expect(fetched).toEqual(["alice-downstream-skills-token", "bob-downstream-skills-token", "alice-downstream-skills-token"]);
  const anonymous = new SkillsRegistry(root.scoped({ connectorIds: "all" }), BASE);
  expect((await anonymous.list()).skills).not.toContainEqual(expect.objectContaining({ uri }));
});

it("INV-8: rejects malformed, out-of-root and oversized manifests atomically", async () => {
  for (const resources of [[], [{ uri: URI, digest: "wrong", size: 1 }], [{ uri: URI, digest: DIGEST, size: 16 * 1024 * 1024 + 1 }],
    [{ uri: URI, digest: DIGEST, size: 1 }, { uri: "skill://vendor/other/file", digest: DIGEST, size: 1 }]]) {
    const remote = downstream("remote", { list: async ctx => [{ ...(await downstream().downstreamSkills!.list(ctx))[0]!, resources }] });
    await expect(new SkillsRegistry(makeRegistry([remote]), BASE).list()).rejects.toMatchObject({ code: "unavailable" });
  }
});

it("INV-8: refuses invalid downstream Agent Skills frontmatter without rewriting it", async () => {
  for (const frontmatter of [{ name: "with_underscore", description: "Description" },
    { name: "-edge", description: "Description" }, { name: "double--hyphen", description: "Description" },
    { name: "a".repeat(65), description: "Description" }, { name: "review", description: "x".repeat(1025) }]) {
    const remote = downstream("remote", { list: async ctx => [{ ...(await downstream().downstreamSkills!.list(ctx))[0]!, frontmatter }] });
    await expect(new SkillsRegistry(makeRegistry([remote]), BASE).list()).rejects.toMatchObject({ code: "unavailable" });
  }
});

it("INV-7: cancels bounded skill work and closes its owned connector scope", async () => {
  let signal: AbortSignal | undefined;
  const closeScope = vi.fn(async () => {});
  const remote = downstream("remote", { list: async ctx => { signal = ctx.signal; return new Promise(() => {}); } });
  remote.closeScope = closeScope;
  await expect(new SkillsRegistry(makeRegistry([remote]), BASE, { probeTimeoutMs: 5 }).list()).rejects.toMatchObject({ code: "unavailable" });
  expect(signal?.aborted).toBe(true);
  expect(closeScope).toHaveBeenCalledTimes(1);
  const guest = (await buildSandboxProviders(makeRegistry([remote]), BASE, silentLogger, undefined, { hostCallTimeoutMs: 5 }))[0]!.fns;
  await expect(guest.skill!(downstreamSkillUri("remote", URI))).rejects.toMatchObject({ code: "timeout" });
  expect(signal?.aborted).toBe(true);
  // The outer utility deadline must reach the asynchronous downstream work.
  await vi.waitFor(() => expect(closeScope).toHaveBeenCalledTimes(2));
});

it("INV-8: manifests local bytes and retains authority-rooted downstream skill names", async () => {
  const registry = new SkillsRegistry(makeRegistry([guided("local")]), BASE);
  const entry = (await registry.get("connector:local")).skill;
  const text = (await registry.read(entry.uri)).contents[0]!.text!;
  const body = text.slice(text.indexOf("\n---\n") + 5);
  expect(body).toBe("\n# local\n\nRead local.\n");
  expect(JSON.parse(text.split("\n---\n")[0]!.slice(4))).toEqual(entry.frontmatter);
  const bytes = new TextEncoder().encode(text);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  expect(entry.resources).toEqual([{ uri: entry.uri, digest: `sha256:${hash}`, size: bytes.length }]);
  expect(downstreamSkillUri("remote", "skill://review/SKILL.md").endsWith("/review/SKILL.md")).toBe(true);
});

it("INV-8: gives every permitted connector ID a valid and distinct Agent Skills slug", async () => {
  const ids = ["with_underscore", "with-underscore", "-edge-", "a".repeat(90)];
  const registry = new SkillsRegistry(makeRegistry(ids.map(id => guided(id))), BASE);
  const names: string[] = [];
  for (const id of ids) {
    const entry = (await registry.get(`connector:${id}`)).skill;
    const name = String(entry.frontmatter.name);
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(entry.uri).toBe(`skill://connecta/connectors/${name}/SKILL.md`);
    expect((await registry.read(`skill://connecta/connectors/${id}`)).contents[0]?.uri).toBe(entry.uri);
    names.push(name);
  }
  expect(new Set(names).size).toBe(ids.length);
});

it("INV-4: filters connector and downstream skills before touching the caller's partition", async () => {
  const hiddenList = vi.fn(async () => []);
  const contexts: ConnectorContext[] = [];
  const remote = downstream("remote", { list: async ctx => { contexts.push(ctx); return (await downstream().downstreamSkills!.list(ctx)); } });
  const root = makeRegistry([remote, downstream("hidden", { list: hiddenList }), guided("hidden-guide")]);
  const view = root.scoped({ connectorIds: ["remote"], principalKey: "alice", subjectKey: "alice", caller: { identity: { actor: { kind: "test", id: "alice" }, principal: { namespace: "test", id: "alice" }, interactive: true }, authenticated: true, pool: "engineering" } });
  const registry = new SkillsRegistry(view, BASE);
  expect((await registry.list()).skills.map(s => s.uri)).toContain(downstreamSkillUri("remote", URI));
  expect(hiddenList).not.toHaveBeenCalled();
  expect(callerOf(contexts[0]!)).toMatchObject({ identity: { principal: { id: "alice" } }, pool: "engineering" });
  await expect(registry.read(downstreamSkillUri("hidden", URI))).rejects.toMatchObject({ code: "not_found" });
});

it("INV-5 INV-6: preserves downstream bytes and manifests except sent credential echoes", async () => {
  const records: unknown[] = [];
  const logger = { debug: (...args: unknown[]) => records.push(args), info: (...args: unknown[]) => records.push(args), warn: (...args: unknown[]) => records.push(args), error: (...args: unknown[]) => records.push(args) };
  const registry = new SkillsRegistry(makeRegistry([downstream()], { logger }), BASE);
  const uri = downstreamSkillUri("remote", URI);
  expect((await registry.get(uri)).skill).toMatchObject({ frontmatter: { custom: [1, 2] }, resources: [{ digest: DIGEST }] });
  expect((await registry.read(uri)).contents[0]?.text).toBe(TEXT);
  const secret = "sent-downstream-skills-credential";
  const echo = downstream("echo", { read: async (uri, ctx) => { sentSecretsFor(ctx).secret(secret); return [{ uri, text: TEXT + secret }]; } });
  const c = createTestConnecta({ connectors: [echo], logger });
  const echoed = await rpc(c, "resources/read", { uri: downstreamSkillUri("echo", URI) });
  expect(echoed.error).toBeUndefined();
  expect(JSON.stringify(echoed)).not.toContain(secret);
  expect(echoed.result.contents[0].text).toContain("[redacted]");
  expect(JSON.stringify(records)).not.toContain(TEXT);
  expect(JSON.stringify(records)).not.toContain(secret);
  await c.close();
});

it("INV-8: rejects the complete listing when any opted-in catalog fails", async () => {
  const failed = downstream("failed", { list: async () => { throw new Error(TEXT); } });
  const registry = new SkillsRegistry(makeRegistry([guided("local"), downstream(), failed]), BASE);
  await expect(registry.list()).rejects.toMatchObject({ code: "unavailable" });
  await expect(registry.get(downstreamSkillUri("remote", URI))).rejects.toMatchObject({ code: "unavailable" });
  // Local known skills remain usable during a downstream outage.
  expect((await registry.read("skill://connecta/usage")).contents[0]?.text).toContain("# Connecta usage");
});

it("INV-5 INV-6 INV-10: proxies the real downstream MCP transport through the private Skills boundary", async () => {
  const secret = "skills-transport-sent-credential";
  const text = TEXT + "Authorization: example\n" + secret;
  const digest = "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const methods: string[] = [];
  const records: unknown[] = [];
  const logger = { debug: (...args: unknown[]) => records.push(args), info: (...args: unknown[]) => records.push(args), warn: (...args: unknown[]) => records.push(args), error: (...args: unknown[]) => records.push(args) };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${secret}`);
    const message = await request.json() as { id: number; method: string; params?: { uri?: string } };
    methods.push(message.method);
    const result = message.method === "server/discover"
      ? { supportedVersions: ["2026-07-28"], capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "test", version: "1" } } }
      : message.method === "skills/list"
        ? { skills: [{ uri: URI, frontmatter: { name: "review", description: "Review changes." }, resources: [{ uri: URI, digest, size: new TextEncoder().encode(text).length }] }] }
        : { contents: [{ uri: message.params!.uri, text }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result } });
  });
  const connector = remoteMcp("remote", { url: "https://skills.test/mcp", skills: true, auth: { type: "headers", headers: { Authorization: `Bearer ${secret}` } }, logger });
  const c = createTestConnecta({ connectors: [connector], logger });
  try {
    const uri = downstreamSkillUri("remote", URI);
    const get = await rpc(c, "skills/get", { uri });
    expect(get.result).toMatchObject({ cacheScope: "private", skill: { uri, resources: [{ uri, digest }] } });
    const read = await rpc(c, "resources/read", { uri });
    expect(read.result).toMatchObject({ cacheScope: "private", contents: [{ uri, text: TEXT + "Authorization: [redacted]\n[redacted]" }] });
    const mt = await createMetaTools(makeRegistry([connector], { logger }), BASE).skills({ name: uri });
    expect(mt.content[0]?.text).toBe(read.result.contents[0].text);
    expect(methods).toContain("skills/list");
    expect(methods).toContain("resources/read");
    expect(JSON.stringify(records)).not.toContain(TEXT);
    expect(JSON.stringify(records)).not.toContain(secret);
  } finally {
    await c.close();
    vi.unstubAllGlobals();
  }
});

it("INV-3 INV-4: serves only advertised skill files and keeps all four readers in parity", async () => {
  const root = makeRegistry([guided("local"), downstream()]);
  const c = createTestConnecta({ connectors: root.listConnectors(), logger: silentLogger });
  const discovery = await rpc(c, "server/discover");
  expect(discovery.result.capabilities).toMatchObject({ resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } });
  const listed = await rpc(c, "skills/list");
  expect(listed.result).toMatchObject({ resultType: "complete", cacheScope: "private", ttlMs: 0 });
  for (const uri of ["skill://connecta/usage/SKILL.md", "skill://connecta/connectors/local/SKILL.md", downstreamSkillUri("remote", URI)]) {
    const get = await rpc(c, "skills/get", { uri });
    const read = await rpc(c, "resources/read", { uri });
    expect(read.error).toBeUndefined();
    const mt = await createMetaTools(root, BASE).skills({ name: uri });
    const guest = (await buildSandboxProviders(root, BASE, silentLogger))[0]!.fns;
    const skill = await guest.skill!(uri) as { text: string };
    expect(get.result.skill.uri).toBe(uri);
    expect(read.result.contents[0].text).toBe(mt.content[0]?.text);
    expect(skill.text).toBe(mt.content[0]?.text);
    expect(read.result.cacheScope).toBe("private");
  }
  const alias = await createMetaTools(root, BASE).skills({ name: "connector:local" });
  const canonical = await rpc(c, "resources/read", { uri: "skill://connecta/connectors/local/SKILL.md" });
  expect(alias.content[0]?.text).toBe(canonical.result.contents[0].text);
  const resources = await rpc(c, "resources/list");
  expect(resources.result.cacheScope).toBe("private");
  const forbidden = await rpc(c, "resources/read", { uri: "https://vendor.test/arbitrary" });
  expect(forbidden.error.code).toBe(-32602);
  const unknown = await rpc(c, "skills/get", { uri: "skill://downstream/remote/unadvertised/SKILL.md" });
  expect(unknown.error.code).toBe(-32602);
  await c.close();
});
