// Whose account a Google Workspace connector acts as, for the operator
// matrix (#837, decisions/0006). The Workspace providers tag the connector
// they build; nothing else can, and nothing a request sends reaches this.
// Read only by the operator contract, which never shows a mapping function.

/** A mapping subject resolves per caller; a fixed one is the same address for everyone. */
type WorkspaceSubjectKind = { kind: "mapping" } | { kind: "fixed"; subject: string };

const tagged = new WeakMap<object, WorkspaceSubjectKind>();

/** Tag a Workspace connector with its subject kind, returning it unchanged. */
export function tagWorkspaceSubject<C extends object>(
  connector: C,
  subject: string | ((...args: never[]) => unknown),
): C {
  tagged.set(connector, typeof subject === "string" ? { kind: "fixed", subject } : { kind: "mapping" });
  return connector;
}

/**
 * The subject kind of a tagged connector, or undefined for any other. Walks
 * the prototype chain, since provider construction may wrap a connector it
 * cannot restamp in an object that inherits from it.
 */
export function workspaceSubjectOf(connector: object): WorkspaceSubjectKind | undefined {
  for (let current: object | null = connector; current; current = Object.getPrototypeOf(current) as object | null) {
    const subject = tagged.get(current);
    if (subject) return subject;
  }
  return undefined;
}
