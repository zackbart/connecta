// Several api() connectors sharing one downstream OAuth grant (#1416).
//
// A grant owner is an OAuth connector whose id keys the grant's storage, its
// sealing and its callback. A connector tagged with another owner reads and
// writes that owner's grant, and every Connect link for it names the owner.
// Tags are construction facts; nothing a request sends can change them.

const owners = new WeakMap<object, string>();

/** Tag a connector with the id of the connector whose grant it uses. */
export function tagGrantOwner<C extends object>(connector: C, owner: string): C {
  owners.set(connector, owner);
  return connector;
}

/** A tagged connector's grant owner; walks the prototype chain, as wrappers inherit. */
export function grantOwnerOf(connector: object): string | undefined {
  for (let current: object | null = connector; current; current = Object.getPrototypeOf(current) as object | null) {
    const owner = owners.get(current);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

interface GroupedConnector {
  readonly id: string;
  readonly authScope?: "shared" | "personal" | undefined;
  readonly startAuth?: unknown;
}

/**
 * Each grant owner's other connectors, checked: a tagged connector's owner is
 * configured, owns its own grant, and has the same `authScope`.
 */
export function grantGroups(connectors: Iterable<GroupedConnector>): Map<string, string[]> {
  const byId = new Map<string, GroupedConnector>();
  for (const connector of connectors) byId.set(connector.id, connector);
  const groups = new Map<string, string[]>();
  for (const connector of byId.values()) {
    const owner = grantOwnerOf(connector);
    if (owner === undefined || owner === connector.id) continue;
    const account = byId.get(owner);
    if (!account) {
      throw new Error(
        `Connector "${connector.id}" uses the OAuth grant of connector "${owner}", which is not configured. Add every connector googleAccount() returns.`,
      );
    }
    if (grantOwnerOf(account) !== owner || !account.startAuth) {
      throw new Error(`Connector "${connector.id}" uses connector "${owner}"'s OAuth grant, but "${owner}" owns none.`);
    }
    if ((account.authScope ?? "shared") !== (connector.authScope ?? "shared")) {
      throw new Error(
        `Connector "${connector.id}" must have the authScope of connector "${owner}", whose OAuth grant it uses.`,
      );
    }
    const members = groups.get(owner) ?? [];
    members.push(connector.id);
    groups.set(owner, members);
  }
  return groups;
}
