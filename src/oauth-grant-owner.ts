interface GrantTag {
  readonly owner: string;
  /** The one grant the group shares; connectors built for another grant never match it. */
  readonly grant: object;
}

const tags = new WeakMap<object, GrantTag>();

/** Tag a connector with the id of the connector that holds `grant`, which it uses. */
export function tagGrantOwner<C extends object>(connector: C, owner: string, grant: object): C {
  tags.set(connector, { owner, grant });
  return connector;
}

function tagOf(connector: object): GrantTag | undefined {
  for (let current: object | null = connector; current; current = Object.getPrototypeOf(current) as object | null) {
    const tag = tags.get(current);
    if (tag) return tag;
  }
  return undefined;
}

/** A tagged connector's grant owner; walks the prototype chain, as wrappers inherit. */
export function grantOwnerOf(connector: object): string | undefined {
  return tagOf(connector)?.owner;
}

interface GroupedConnector {
  readonly id: string;
  readonly authScope?: "shared" | "personal" | undefined;
}

/**
 * Each grant owner's other connectors, checked: a tagged connector's owner is
 * configured, holds the very grant the connector was built for, and has the
 * same `authScope`.
 */
export function grantGroups(connectors: Iterable<GroupedConnector>): Map<string, string[]> {
  const byId = new Map<string, GroupedConnector>();
  for (const connector of connectors) byId.set(connector.id, connector);
  const groups = new Map<string, string[]>();
  for (const connector of byId.values()) {
    const tag = tagOf(connector);
    if (!tag || tag.owner === connector.id) continue;
    const account = byId.get(tag.owner);
    if (!account) {
      throw new Error(
        `Connector "${connector.id}" uses the OAuth grant of connector "${tag.owner}", which is not configured. Add every connector googleAccount() returns.`,
      );
    }
    const held = tagOf(account);
    if (held?.owner !== tag.owner || held.grant !== tag.grant) {
      throw new Error(
        `Connector "${connector.id}" was built for another OAuth grant than connector "${tag.owner}" holds. Use the connectors of one googleAccount() call together.`,
      );
    }
    if ((account.authScope ?? "shared") !== (connector.authScope ?? "shared")) {
      throw new Error(
        `Connector "${connector.id}" must have the authScope of connector "${tag.owner}", whose OAuth grant it uses.`,
      );
    }
    const members = groups.get(tag.owner) ?? [];
    members.push(connector.id);
    groups.set(tag.owner, members);
  }
  return groups;
}
