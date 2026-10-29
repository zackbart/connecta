import type { OperatorUiContractV2 } from "./contract.js";
import type { FixPromptKind } from "./fix-prompts.js";
import type { UiProblem } from "./model.js";
import { endpointRows } from "./endpoints.js";
import { joinList, type ConnectionMap } from "./connection-map.js";
import { connectorVerdict, type ConnectorSignals } from "./view.js";

/**
 * The Overview's headline and its "Needs attention" list, from operator
 * contract v2 and the page's own failed-read signals. Pure, like
 * the map beside it: a test reads what each row says and links to without a
 * browser.
 */

export interface OverviewHeadline {
  connectors: number;
  healthy: number;
  /** Connectors with a warning, then failing ones. */
  warn: number;
  danger: number;
  /** One tone per connector, in config order, for the health bar. */
  bar: Array<{ id: string; title: string; tone: "ok" | "warn" | "danger" | "neutral"; label: string }>;
  endpoints: number;
  /** Endpoints that refuse write tools. */
  readOnlyEndpoints: number;
  people: number;
  agents: number;
}

export interface AttentionItem {
  key: string;
  kind: "connector" | "agent";
  tone: "warn" | "danger";
  /** The subject, linked in the row: a connector title or an agent name. */
  subject: string;
  /** What is wrong, after the subject: "needs a credential". */
  problem: string;
  /** One short line under the title: where it bites. */
  body: string;
  /** The existing fix: a page that holds the control. Null when this viewer has none. */
  action: { label: string; href: string; ariaLabel: string } | null;
  /** The subject's own page. */
  href: string | null;
  /** The "Copy fix prompt" kind, keyed by the server's problem code. */
  fix: { kind: FixPromptKind; connectorId: string } | null;
}

const PROBLEM_TITLE: Readonly<Record<UiProblem, string>> = {
  connector_unavailable: "is unavailable",
  connector_timeout: "isn't responding",
  oauth_required: "needs authorization",
  credential_required: "needs a credential",
  auth_required: "needs a secret in the deployment",
  caller_refused: "couldn't authenticate as you",
  credential_mismatch: "can't use its saved credential",
  catalog_failed: "couldn't load its tools",
};

function affects(paths: string[]): string {
  return paths.length ? `Affects ${joinList(paths)}` : "No endpoint serves it";
}

/**
 * One row per connector that is not healthy, in config order, then one per
 * agent that sits in an endpoint without a working token. Each row carries
 * the fix the rest of the UI already offers for it.
 */
export function attentionItems(
  contract: OperatorUiContractV2,
  options: { signals?: Readonly<Record<string, ConnectorSignals>>; tokensPage?: boolean } = {},
): AttentionItem[] {
  if (contract.role !== "maintainer") return [];
  const rows = endpointRows(contract);
  const connectors: AttentionItem[] = [];
  for (const config of contract.config?.connectors ?? []) {
    const live = contract.live.connectors.find((c) => c.id === config.id);
    if (!live) continue;
    const signals = options.signals && Object.hasOwn(options.signals, config.id) ? options.signals[config.id]! : {};
    const verdict = connectorVerdict(live, signals);
    if ((verdict.tone !== "warn" && verdict.tone !== "danger") || !verdict.action) continue;
    const title = config.title ?? config.id;
    const id = encodeURIComponent(config.id);
    const paths = rows.filter((row) => row.groups.some((group) => group.config.id === config.id)).map((r) => r.path);
    const connection = `/connectors/${id}#connection`;
    const base = {
      key: `connector:${config.id}`,
      kind: "connector" as const,
      tone: verdict.tone,
      subject: title,
      action: { label: verdict.action, href: connection, ariaLabel: `${verdict.action} ${title}` },
      href: connection,
    };
    // The server's problem code outranks a failed read on this page: the row
    // keeps its fix prompt and says the details didn't load. "Unavailable"
    // beside a failed read is the page's own (see connectorVerdict).
    const reported = live.problem ?? (live.status === "error" ? "connector_unavailable" : undefined);
    const problem = signals.failed && reported === "connector_unavailable" ? undefined : reported;
    if (problem) {
      connectors.push({
        ...base,
        problem: PROBLEM_TITLE[problem],
        body: signals.failed ? `Details didn't load · ${affects(paths)}` : affects(paths),
        fix: problem === "caller_refused" ? null : { kind: problem, connectorId: config.id },
      });
    } else if (signals.failed) {
      connectors.push({
        ...base,
        problem: "didn't load on this page",
        body: affects(paths),
        fix: null,
      });
    } else if (live.status !== "ok") {
      connectors.push({
        ...base,
        problem: verdict.label === "Authorization needed" ? "needs authorization" : "isn't connected",
        body: affects(paths),
        fix: null,
      });
    }
  }
  const agents: AttentionItem[] = contract.agents
    .filter(
      (agent) =>
        agent.pools.length &&
        !agent.credentialTypes.includes("vercel_oidc") &&
        agent.token &&
        agent.token.state !== "issued",
    )
    .map((agent) => {
      // An agent connects only at a pool's agent URL.
      const paths = agent.pools.map(
        (name) => contract.pools.find((pool) => pool.name === name)?.agentPath ?? `/agent/${name}`,
      );
      const revoked = agent.token?.state === "revoked";
      return {
        key: `agent:${agent.name}`,
        kind: "agent",
        tone: "warn",
        subject: agent.name,
        problem: revoked ? "has a revoked token" : "has no token",
        body: `Can't connect at ${joinList(paths)}`,
        action: options.tokensPage
          ? { label: "Issue token", href: "/tokens", ariaLabel: `Issue a token for ${agent.name}` }
          : null,
        href: options.tokensPage ? "/tokens" : null,
        fix: null,
      };
    });
  // Severity changes as individual details settle. Config order keeps surviving
  // rows in place without waiting for the slowest connector's read.
  return [...connectors, ...agents];
}

/** The numbers above the list, counted from the same map the page draws. */
export function overviewHeadline(
  contract: OperatorUiContractV2,
  map: Pick<ConnectionMap, "nodes">,
  items: readonly AttentionItem[],
  signals: Readonly<Record<string, ConnectorSignals>> = {},
): OverviewHeadline {
  const bar = (contract.config?.connectors ?? []).flatMap((config) => {
    const live = contract.live.connectors.find((c) => c.id === config.id);
    if (!live) return [];
    const health = connectorVerdict(live, Object.hasOwn(signals, config.id) ? signals[config.id] : undefined);
    return [{ id: config.id, title: config.title ?? config.id, tone: health.tone, label: health.label }];
  });
  const healthy = bar.filter((entry) => entry.tone === "ok").length;
  const warn = bar.filter((entry) => entry.tone === "warn").length;
  const danger = bar.filter((entry) => entry.tone === "danger").length;
  const count = (kind: string) => map.nodes.filter((node) => node.kind === kind).length;
  return {
    connectors: bar.length,
    healthy,
    warn,
    danger,
    bar,
    endpoints: count("endpoint"),
    readOnlyEndpoints: map.nodes.filter((node) => node.kind === "endpoint" && node.readOnly).length,
    people: count("person"),
    agents: contract.agents.length,
  };
}
