import type { OperatorMemberConnector, OperatorMemberManage, OperatorUiContractV2 } from "./contract.js";
import { connectorStatusLabel, connectorStatusTone, type Tone } from "./view.js";

/**
 * A pool member's one page, computed from the member contract alone: their
 * endpoints, the personal accounts they manage themselves, and the names of
 * what is shared with them. The member contract carries no other people, no
 * agents and no shared-credential state, and nothing here reads a field that
 * would.
 */

interface MemberEndpoint {
  pool: string;
  /** The pool's humanPath. */
  path: string;
}

/**
 * One control on a personal account row. `connect` and `restart` are both
 * `POST /ui/oauth/<id>` (`?mode=continue` and `?mode=restart`); `disconnect`
 * is its DELETE. The credential controls use `/ui/credentials/<id>` in the
 * member's own partition.
 */
export type AccountControl =
  | { kind: "connect"; label: "Connect" | "Reconnect" }
  | { kind: "restart"; label: "Reconnect" }
  | { kind: "disconnect"; label: "Disconnect" }
  | { kind: "save"; label: "Add credential" | "Replace" }
  | { kind: "test"; label: "Test" }
  | { kind: "clear"; label: "Clear" };

export interface MemberAccount {
  id: string;
  title: string;
  toolCount: number;
  /** One badge from `connection.state` and `problem`; null when there is no connection. */
  badge: { label: string; tone: Tone } | null;
  summary: string;
  manage: OperatorMemberManage;
  controls: AccountControl[];
}

interface MemberShared {
  id: string;
  title: string;
  toolCount: number;
}

export interface MemberPageModel {
  endpoints: MemberEndpoint[];
  accounts: MemberAccount[];
  shared: MemberShared[];
}

type Connection = NonNullable<OperatorMemberConnector["connection"]>;

/**
 * Whether the member's own partition holds a credential, read from `actions`
 * alone (P6b): `clear` is listed only when a value is stored. Connection
 * state says whether it works, never whether it exists.
 */
function credentialStored(manage: Extract<OperatorMemberManage, { kind: "credential" }>): boolean {
  return manage.actions.includes("clear");
}

function controlsFor(manage: OperatorMemberManage, connection: Connection): AccountControl[] {
  const can = (action: string) => (manage.kind === "none" ? false : (manage.actions as string[]).includes(action));
  if (manage.kind === "oauth") {
    const connected = connection.state === "ok";
    const controls: AccountControl[] = [];
    if (!connected && can("connect")) {
      controls.push({ kind: "connect", label: connection.state === "auth_required" ? "Connect" : "Reconnect" });
    }
    if (connected && can("restart")) controls.push({ kind: "restart", label: "Reconnect" });
    if (connection.state !== "auth_required" && can("disconnect")) {
      controls.push({ kind: "disconnect", label: "Disconnect" });
    }
    return controls;
  }
  if (manage.kind === "credential") {
    // `save` without `clear`: nothing stored yet. `test` is listed only for a stored value.
    const stored = credentialStored(manage);
    return [
      ...(can("save")
        ? [{ kind: "save" as const, label: stored ? ("Replace" as const) : ("Add credential" as const) }]
        : []),
      ...(can("test") ? [{ kind: "test" as const, label: "Test" as const }] : []),
      ...(can("clear") ? [{ kind: "clear" as const, label: "Clear" as const }] : []),
    ];
  }
  return [];
}

function summaryFor(manage: OperatorMemberManage, connection: Connection): string {
  if (manage.kind === "credential") {
    if (!credentialStored(manage)) {
      return manage.actions.includes("save") ? "Add your credential to use its tools." : "No credential saved.";
    }
    if (connection.problem === "credential_mismatch") return "Your saved credential no longer fits. Replace it.";
    return connection.state === "ok" ? "Your credential is saved." : "Your credential is saved, but it isn't working.";
  }
  if (connection.state === "ok") return "Connected with your account.";
  if (connection.state === "auth_required") {
    return manage.kind === "oauth" && manage.actions.includes("connect")
      ? "Not connected. Its tools won't work for you until you connect."
      : "Not connected.";
  }
  return "Unavailable right now.";
}

const toolCount = (connector: OperatorMemberConnector) => connector.tools.length;

export function memberPage(contract: OperatorUiContractV2 | null): MemberPageModel {
  if (contract?.role !== "member") return { endpoints: [], accounts: [], shared: [] };
  return {
    endpoints: contract.pools.map((pool) => ({ pool: pool.name, path: pool.humanPath })),
    accounts: contract.connectors
      .filter((connector) => connector.authScope === "personal")
      .map((connector) => {
        const connection: Connection = connector.connection ?? { state: "auth_required" };
        return {
          id: connector.id,
          title: connector.title || connector.id,
          toolCount: toolCount(connector),
          badge: connector.connection
            ? {
                label: connectorStatusLabel(connection.state, connection.problem),
                tone: connectorStatusTone(connection.state),
              }
            : null,
          summary: summaryFor(connector.manage, connection),
          manage: connector.manage,
          controls: controlsFor(connector.manage, connection),
        };
      }),
    // Names and counts only: a shared connector's state is not the member's to see.
    shared: contract.connectors
      .filter((connector) => connector.authScope === "shared")
      .map((connector) => ({
        id: connector.id,
        title: connector.title || connector.id,
        toolCount: toolCount(connector),
      })),
  };
}

export function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

/** The in-page question before a member's action that takes something away. */
export function memberConfirmCopy(
  action: "oauth_restart" | "oauth_disconnect" | "credential_remove",
  name: string,
): { question: string; confirm: string } {
  if (action === "oauth_restart") {
    return {
      question: `Reconnect ${name}? Your current connection stops working until you finish authorizing in the new tab.`,
      confirm: "Reconnect",
    };
  }
  if (action === "oauth_disconnect") {
    return {
      question: `Disconnect your ${name} account? Its tools stop working for you until you connect again.`,
      confirm: "Disconnect",
    };
  }
  return {
    question: `Clear your ${name} credential? Its tools stop working for you until you add one again.`,
    confirm: "Clear",
  };
}
