# Migration to 0.33

Use this upgrade guide for an existing deployment moving to 0.33.
[Deployment upgrades](./deploying.md#upgrade-an-existing-deployment) cover the
general procedure; [the agent index](./README.md) routes other work.

0.33 makes pools the access model.
Every deployment with inbound auth changes its configuration. Each removed
option fails construction with a message naming its replacement, so a
deployment that starts has no leftover option silently ignored. Work through
the sections in order, then [verify](#verify).

## Old option to new option

| 0.32                                                                                  | 0.33                                                                                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.connectorAccess`                                                            | A pool per audience, with `tools` and `members`. A guarded `{ tool, requireReadOnly: true }` grant becomes a pool with `readOnly: true` |
| Top-level `grant`                                                                     | `maintainers`                                                                                                                           |
| Pool `grant`                                                                          | Pool `members`                                                                                                                          |
| `describeConfig().hasGrant` (root and pools)                                          | `describeConfig().maintainers` and each pool's `members`                                                                                |
| `identity.credentialAdministration`                                                   | `maintainers` (interactive)                                                                                                             |
| `identity.personalConnection`                                                         | Pool `members` for personal connectors in their pools; maintainers for their own                                                        |
| `identity.accessTokenManagement`                                                      | `maintainers` (interactive)                                                                                                             |
| `identity.activityAccess`                                                             | `maintainers`, still narrowed by `activity.readGate`                                                                                    |
| The `identity` section, even empty                                                    | Removed; delete it                                                                                                                      |
| `ConnectaIdentityConfig`, `ConnectorPermission` types                                 | Removed                                                                                                                                 |
| Tokens created or named in the UI, human-bound tokens                                 | `agents: ["<name>"]`, one token slot each                                                                                               |
| `accessTokens(storage, { maxActive })`                                                | `accessTokens(storage)`                                                                                                                 |
| `describeConfig().modules.accessTokens.maxActive`                                     | `describeConfig().agents`                                                                                                               |
| Node template `provision-token`                                                       | `npm run --silent rotate-token -- <agent>`; existing tokens: `npm run adopt-token`                                                      |
| A machine at `/mcp` or `/mcp/<pool>` with `cta_`                                      | `/agent/<pool>`, with `"agent:<name>"` in the pool's `members`                                                                          |
| Access service token plus `cta_` behind Cloudflare Access                             | `cta_` alone, through an `/agent/*` Access Bypass application                                                                           |
| Grant callbacks matching token record ids                                             | Membership by agent name; `identity.agent` in custom code                                                                               |
| A Workspace `subject` mapping that answered for machine tokens                        | The pool's `owner`                                                                                                                      |
| One Workspace connector per person (`gmail_alice`)                                    | One connector with a mapping `subject`, plus pool owners                                                                                |
| `POST`/`DELETE /ui/access-tokens/<agent>` without a body                              | `{ "expect": "<revision>" }` from `GET /ui/access-tokens`                                                                               |
| Operator contract `schemaVersion: 1`, `you.grants`, `you.permissions`, and `hasGrant` | `schemaVersion: 2` with `role`, `root`, `pools`, `agents`, `matrix`, and `connectors`; `OperatorUiContract` names v2                    |
| `OperatorViewer`, `OperatorPool` types                                                | Removed; `OperatorPoolV2`, `OperatorRootEndpoint`, `OperatorMemberConnector` and the other v2 types                                     |
| `/ui/data`, `/ui/connectors/<id>`                                                     | Maintainers only; members read their view from `/ui/api/config`                                                                         |
| A connector that connects with `startAuth` alone, or disconnects only alongside it    | Connect needs `startAuth`, `finishAuth`, and `verifyState`; disconnect needs only `disconnectAuth`                                      |
| `DELETE /ui/credentials/<id>` on an empty slot answering 204                          | 409 `{ "problem": "credential_required" }`                                                                                              |
| The `agent_not_maintainer` denial reason                                              | Removed; agents are refused at human endpoints before admission                                                                         |

## Maintainers and pool members

0.32 combined an identity resolver, a top-level `grant`, and pool `grant`
callbacks. 0.33 reads access from two static lists in code:

- `maintainers` names the people who reach plain `/mcp`, which serves the
  whole catalog, and every operator route. It is required whenever an inbound
  provider that admits people is configured.
- Each pool's `members` names who reaches it: people at `/mcp/<pool>`, agents
  as `"agent:<name>"` at `/agent/<pool>`. A pool serves exactly its `tools`,
  intersected with nothing. A maintainer opens no pool implicitly.

```ts
// 0.32
createConnecta({
  auth: clerkAuth({ publishableKey, secretKey }),
  grant: ({ principal }) => principal?.id === "user_alice",
  identity: { connectorAccess, credentialAdministration, activityAccess },
  pools: {
    support: { tools: ["tickets", "crm.search"], grant: ({ principal }) => support.has(principal?.id ?? "") },
  },
  // …
});

// 0.33
createConnecta({
  auth: clerkAuth({ publishableKey, secretKey }),
  maintainers: ["user_alice"],
  pools: {
    support: { tools: ["tickets", "crm.search"], members: [...support] },
  },
  // …
});
```

A reference is a bare principal id when the deployment has exactly one
interactive provider, `{ namespace, id }` otherwise, or `"agent:<name>"`.
Rewrite a predicate as the list it computed; ordinary code at construction
(`team.map(...)`) can build it. [Principals and operators](./auth.md#principals-visibility-and-operators)
owns the rules. A non-maintainer at `/mcp`, a non-member, and an undeclared
pool get the same 404.

### Preserve effective access

Before deleting `identity.connectorAccess`, compute what each audience could
actually use: its endpoint's tools intersected with that identity's old
connector permissions, including read-only guards. Write that effective set
into the new pool. Copying an old pool's broader `tools` verbatim would widen
access because 0.33 has no second intersection. A person previously admitted
to plain `/mcp` with restricted connector permissions needs a pool and a new
`/mcp/<pool>` client URL, not a maintainer entry. Maintainers have the whole
root catalog and administrative authority.

For example, suppose Alice administered the deployment, while Bob's old team
pool listed `crm` and `tickets` but his `connectorAccess` allowed only
`{ tool: "tickets.search", requireReadOnly: true }`. The new configuration is:

```ts
maintainers: ["user_alice"],
pools: {
  team: { tools: ["tickets.search"], members: ["user_bob"], readOnly: true },
},
// Delete identity and all grant callbacks; Bob connects at /mcp/team.
```

A read-only guard applies to the whole new endpoint. If an audience previously
had both writable tools and guarded reads, separate those into explicit pools
with the appropriate `readOnly` choice rather than dropping the guard. Then
update clients to the intended endpoints.

## Management

The four management resolvers are gone, and the `identity` section with them.
[Management permissions](./auth.md#management-permissions) has the table:
interactive maintainers administer shared credentials and OAuth grants and
issue, rotate, and revoke agent tokens; maintainers read activity, within an
optional `readGate`; a pool member connects and disconnects their own account
on a personal connector in one of their pools. Agents manage nothing.

## Agents and their tokens

Machine clients are agents declared by name. Each has one token slot that a
maintainer issues, rotates, and revokes; nothing outside code adds, renames,
or rebinds one, and removing a name stops its token on the next request.

1. Add `agents: ["<name>", …]` and keep `accessTokens(storage)` on the same
   storage and key namespace. Drop `maxActive`. A Node template deployment
   from before 0.33 also copies `src/rotate-token.ts` and `src/adopt-token.ts`
   from `node_modules/@zackbart/connecta/templates/node/src/`, deletes
   `src/provision-token.ts`, and replaces the `provision-token` and `doctor`
   scripts with the installed template's `rotate-token`, `adopt-token`, and
   `doctor` (`connecta doctor --pool <pool>`) scripts.
2. Keep each machine's existing secret by adopting its token once:
   `npm run adopt-token` lists the tokens that can be adopted, and
   `npm run adopt-token -- <token-id> <agent>` binds one (Node template), or
   call `AccessTokenManager.adopt(tokenId, agent)` from trusted provisioning.
   Until then the token refuses.
3. A human-bound token, issued from the UI before 0.33, cannot be adopted and
   stays refused. Issue that agent a new token with
   `npm run --silent rotate-token -- <agent>` or from the Tokens page.
4. Clients that call the token routes send the slot's `revision`:
   `POST /ui/access-tokens/<agent>` (issue, rotate) and `DELETE` (revoke) take
   `{ "expect": "<revision>" }` from `GET /ui/access-tokens`, and a slot that
   changed answers 409 `slot_changed`. A missing `expect` is 400.
   `AccessTokenManager` takes the same optional `expect`.

### Programmatic token management

Trusted provisioning code that constructs its own `AccessTokenManager` must
pass the declared agents. The deployment's top-level `agents` does not bind a
separately constructed manager, so `new AccessTokenManager(storage)` knows no
agent and every `rotate` and `adopt` fails with `unknown_agent`.

| 0.32                                             | 0.33                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `new AccessTokenManager(storage, { maxActive })` | `new AccessTokenManager(storage, { agents })`, with the same names as the deployment's `agents`                |
| `create(name, createdBy)`                        | `rotate(agent, issuedBy?, options?)`, returning `{ token, agent }`; the first rotation issues the slot's token |
| `rename(id, name)`                               | Removed; agents are named only in code                                                                         |
| `revoke(tokenId, revokedBy)`                     | `revoke(agent, options?)`, returning the slot                                                                  |
| `list()` of token records                        | `list()` of one slot per declared agent: `{ name, state, issuedAt?, revokedAt?, revision }`                    |
| (none)                                           | `adopt(tokenId, agent, options?)` and `unboundTokens()` for tokens issued before agents                        |

`options` is `{ expect?, signal?, deadline? }`. `expect` is the slot
`revision` read from `list()`; when given, a slot that changed since refuses
with an `AccessTokenError` whose `code` is `slot_changed`, and nothing is
minted or written. Without it the calls behave as before.

```ts
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";

const manager = new AccessTokenManager(storage, { agents: ["assistant"] });
const slot = (await manager.list()).find((agent) => agent.name === "assistant")!;
const { token } = await manager.rotate("assistant", "provisioning", { expect: slot.revision });
```

Rotation is an immediate cutover: the old secret refuses on its next request.
An agent has no principal, so personal connectors are absent for it.
[Agent tokens](./auth.md#agent-tokens-and-upgrading-from-earlier-tokens) owns
the slot, revision, and adoption contracts.

## Agent endpoints

Agents move from `/mcp/<pool>` to `/agent/<pool>`, and every human route
(`/mcp`, `/mcp/<pool>`, the operator pages and APIs, `/connect`, OAuth starts
and callbacks) refuses a `cta_` token before reading token storage. Agents are
never maintainers, so a machine that used plain `/mcp` moves to a pool that
holds its tools.

1. List `"agent:<name>"` in the `members` of each pool the agent uses.
2. Point its client at `https://<host>/agent/<pool>` with
   `Authorization: Bearer cta_…` as its only credential.
3. Behind Cloudflare Access, add one self-hosted Access application per agent
   hostname for `<host>/agent/*` with a single Bypass policy, beside the
   Worker-level application, then drop the agent's `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers. The
   [deploying guide](./deploying.md#agent-endpoints-behind-cloudflare-access)
   has the steps and the checks to repeat until the change settles. Never
   bypass any other path.
4. Run `connecta doctor --pool <pool>` with the agent's token; doctor checks
   `/agent/<pool>` for a `cta_` token and requires `--pool`.

[Agent endpoints](./auth.md#agent-endpoints) owns the path, auth, and
membership contract.

## Google Workspace pool owners

In 0.32 a `cta_` token reached a Workspace connector's `subject` mapping,
which usually answered nothing for a caller without a principal. In 0.33 an
agent never reaches the mapping. It acts as the `owner` of the pool it came
through, and fails `auth_required` in a pool without one. People always act
as themselves through the mapping, in any pool. A fixed `subject` address
still applies to every caller.

If your mapping returned an address for a machine token, set that address as
the `owner` of the agent's pool. Replace per-person connectors such as
`gmail_alice` and `gmail_bob` with one `gmail()` whose `subject` is a mapping
function, and give each person's pool its `owner`.
[Pool owners](./auth.md#pool-owners-for-google-workspace) owns the rules.

## Operator contract v2

`GET /ui/api/config` serves `OperatorUiContractV2` (`schemaVersion: 2`) and
is the operator page's only gate; the v1 contract is removed:

- A signed-out caller gets 401 with the auth challenge.
- A `cta_` agent token gets the machine-only 401 Bearer challenge, as on every
  human route, before token storage is read.
- A signed-in person who is neither a maintainer nor in any pool's `members`
  gets the private JSON 404.
- A maintainer, or a person in a pool's `members`, gets 200 with their `role`.

The maintainer view carries `config`, `configSources`, `root`, every pool
with its owner and labelled members, every declared agent with its token slot
and `lastSeenAt`, and the connector × endpoint `matrix`. The member view
carries only that member's pools, without owner or members, and the
connectors in them, with their own connection and a `manage` naming the
actions they may take. `/ui/data` and `/ui/connectors/<id>` are
maintainer-only and give anyone else the same 404. Code that read v1's
`hasGrant`, `you.grants`, or `you.permissions` reads v2's `role`, `root`,
`pools`, `agents`, `matrix`, and `connectors` instead;
[the operator contract](./operator-ui.md#operator-data-contract) documents
every field. Read the published declarations in
`dist/operator-ui/contract.d.ts` inside the installed package for the exact
typed shape; `you.interactive` remains in v2. `OperatorUiContract` now names v2, and `OperatorViewer` and
`OperatorPool` are removed. `connecta doctor --config` reads v2 and prints a
maintainer's `config`; a member's view has none.

The connector auth routes accept what `manage` lists, with one recovery
exception: a stored credential that cannot be read can still be cleared,
although `manage` lists only `save` in that state.
`/ui/oauth/<id>` gates each verb on its own hooks: connecting needs
`startAuth`, `finishAuth`, and `verifyState`, and disconnecting needs only
`disconnectAuth`. A custom connector that offered connect with `startAuth`
alone adds the other two, without which its callback never completed. A
connector provisioned out of band, with `disconnectAuth` and no `startAuth`,
can now be disconnected. `DELETE /ui/credentials/<id>` refuses to clear a slot
that holds nothing, the caller's own partition for a personal connector, with
409 `{ "error": "no credential is stored to clear", "problem": "credential_required" }`.
The bundled operator UI needs no change.

## Security fix: pre-auth listen buffering

Versions 0.29.0 through 0.32.0 buffered the whole body of an unauthenticated
`POST` carrying `Mcp-Method: subscriptions/listen` to `/mcp` or `/mcp/<pool>`,
with no byte cap, before authentication and request admission. An anonymous
client could hold unbounded memory per request without taking an admission
permit. No credential or data was exposed; the risk is memory exhaustion.

0.33 authenticates first, then checks endpoint admission, before reading any
body on `/mcp`, `/mcp/<pool>`, and `/agent/<pool>`. A pre-dispatch read takes
at most 64 KiB; past that, connecta answers 413 with JSON-RPC code `-33006`
and stops reading. The new `/agent/*` Access bypass therefore does not reopen
the issue.

What operators should know:

- The fix ships in 0.33.0 only; there is no patch release for 0.29–0.32.
  Upgrade.
- No configuration change is needed for the fix itself.
- A Worker behind a Worker-level Access application received only requests
  Access admitted. A deployment reachable without edge authentication, such
  as Node behind a public URL, was exposed. If you cannot upgrade at once,
  cap request body size at your proxy or refuse unauthenticated requests that
  carry `Mcp-Method: subscriptions/listen` there.

## Moving to the agent pool layout

A 0.32 agent usually reached `/mcp/<pool>` through a pool `grant` matching
its token, often with one connector per person and a second connection or
pool for each person's accounts. Move it to
[connecta's agent pool layout](./auth.md#organizing-an-agents-pools): one
connection; a base pool named after the agent with shared connectors and no
owner; one `<agent>-<user>` pool per person with their own connectors and
their Workspace address as `owner`.

```ts
// 0.32
pools: {
  assistant: {
    tools: ["crm", "tickets", "notes_alice", "gmail_alice", "notes_bob", "gmail_bob"],
    grant: ({ actor }) => actor.kind === "access_token" && actor.id === assistantTokenId,
  },
},

// 0.33
agents: ["assistant"],
pools: {
  assistant,
  "assistant-alice": { ...assistant, tools: [...assistant.tools, "notes_alice", "gmail"], owner: "alice@example.com" },
  "assistant-bob": { ...assistant, tools: [...assistant.tools, "notes_bob", "gmail"], owner: "bob@example.com" },
},
// with const assistant = { tools: ["crm", "tickets"], members: ["agent:assistant"] };
```

1. Declare the agent in `agents` and adopt its token (see
   [Agents and their tokens](#agents-and-their-tokens)).
2. Define the base pool `<agent>` once with the shared connectors and
   `members: ["agent:<agent>"]`, and spread it into one `<agent>-<user>` pool
   per person, adding that person's connectors and `owner`.
3. Collapse per-person Workspace connectors into one connector with a mapping
   `subject`. Keep other per-person accounts as their own shared-auth
   connector ids (`notes_alice`) and list each only in its person's pool.
4. Change the agent's client to one connection whose URL it sets per turn:
   `/agent/<agent>-<user>` in a one-on-one with that user, `/agent/<agent>`
   otherwise. Remove any second Connecta connection.
5. Add this line to your deployment's own AGENTS.md (or its CLAUDE.md
   equivalent), so agents find all operator procedures after the upgrade:

   ```text
   For every Connecta operator task, start at node_modules/@zackbart/connecta/documentation/README.md#operator-tasks
   ```

## Verify

1. Start the deployment; construction errors name each removed option's
   replacement.
2. Sign in as a maintainer and confirm plain `/mcp` and the operator UI work.
3. Run `connecta doctor --pool <pool>` with each agent's token, and confirm
   the same token at `/mcp` is refused.
4. Confirm a pool member sees exactly that pool's tools at `/mcp/<pool>`.
5. For Workspace, call a read in an agent's personal pool and confirm it acts
   as the pool's owner. In the base pool, confirm Workspace connectors are
   absent: search finds none of their tools and a call fails
   `unknown_address`. `auth_required` is what an agent gets only in a pool
   without an owner that does list a Workspace connector.
6. Confirm each `<agent>-<user>` pool lists no other person in `members`.
