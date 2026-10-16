import type { OperatorUiContractV2 } from "./contract.js";
import type { FixPromptKind } from "./fix-prompts.js";
import type { UiProblem } from "./model.js";
import { endpointRows } from "./endpoints.js";
import { joinList, plural, type ConnectionMap } from "./connection-map.js";
import { connectorVerdict, type ConnectorSignals } from "./view.js";

/**
 * The Overview's headline and its "Needs attention" list, from operator
 * contract v2 and the page's own drift and failed-read signals. Pure, like
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
  /** One plain sentence under the heading. */
  sentence: string;
}

export interface AttentionItem {
  key: string;
  kind: "connector" | "agent";
  tone: "warn" | "danger";
  /** The subject, linked in the row: a connector title or an agent name. */
  subject: string;
  /** What is wrong, after the subject: "needs a credential". */
  problem: string;
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
  oauth_required: "needs authorization",
  credential_required: "needs a credential",
  auth_required: "needs a secret in the deployment",
  credential_mismatch: "can't use its saved credential",
  catalog_failed: "couldn't load its tools",
};

const PROBLEM_BODY: Readonly<Record<UiProblem, string>> = {
  connector_unavailable: "Its status check or tool list failed or timed out. The deployment log has the error.",
  oauth_required: "No OAuth grant is stored, or the grant expired or was revoked.",
  credential_required: "Nothing usable is stored in its credential slot.",
  auth_required: "Its secret is set in deployment config, so the fix is in code or the environment.",
  credential_mismatch: "The saved credential doesn't match the fields this connector declares.",
  catalog_failed: "It connected, but its tool list failed to load, so none of its tools are served.",
};

function affects(paths: string[]): string {
  return paths.length ? `Affects ${joinList(paths)}.` : "No endpoint serves it.";
}

/**
 * One row per connector that is not healthy, failing first, then one per
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
    const signals = options.signals?.[config.id] ?? {};
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
      const unread = signals.failed ? " Its details also couldn't be read on this page." : "";
      connectors.push({
        ...base,
        problem: PROBLEM_TITLE[problem],
        body: `${PROBLEM_BODY[problem]}${unread} ${affects(paths)}`,
        fix: { kind: problem, connectorId: config.id },
      });
    } else if (signals.failed) {
      connectors.push({
        ...base,
        problem: "didn't load on this page",
        body: `Its details couldn't be read. Open it to try again. ${affects(paths)}`,
        fix: null,
      });
    } else if (live.status !== "ok") {
      connectors.push({
        ...base,
        problem: verdict.label === "Authorization needed" ? "needs authorization" : "isn't connected",
        body: affects(paths),
        fix: null,
      });
    } else {
      // Healthy but drifted: the live tool list differs from the reviewed one.
      connectors.push({
        ...base,
        problem: "has a changed tool list",
        body: `Its live tools differ from the reviewed manifest. New tools stay withheld until a release classifies them. ${affects(paths)}`,
        fix: { kind: "catalog_drift", connectorId: config.id },
      });
    }
  }
  const agents: AttentionItem[] = contract.agents
    .filter((agent) => agent.pools.length && agent.token.state !== "issued")
    .map((agent) => {
      // An agent connects only at a pool's agent URL.
      const paths = agent.pools.map(
        (name) => contract.pools.find((pool) => pool.name === name)?.agentPath ?? `/agent/${name}`,
      );
      const revoked = agent.token.state === "revoked";
      return {
        key: `agent:${agent.name}`,
        kind: "agent",
        tone: "warn",
        subject: agent.name,
        problem: revoked ? "has a revoked token" : "has no token",
        body: `It's in ${joinList(paths)} but can't connect until you issue ${revoked ? "a new one" : "one"}.`,
        action: options.tokensPage
          ? { label: "Issue token", href: "/tokens", ariaLabel: `Issue a token for ${agent.name}` }
          : null,
        href: options.tokensPage ? "/tokens" : null,
        fix: null,
      };
    });
  return [
    ...connectors.filter((item) => item.tone === "danger"),
    ...connectors.filter((item) => item.tone === "warn"),
    ...agents,
  ];
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
    const health = connectorVerdict(live, signals[config.id]);
    return [{ id: config.id, title: config.title ?? config.id, tone: health.tone, label: health.label }];
  });
  const healthy = bar.filter((entry) => entry.tone === "ok").length;
  const warn = bar.filter((entry) => entry.tone === "warn").length;
  const danger = bar.filter((entry) => entry.tone === "danger").length;
  const count = (kind: string) => map.nodes.filter((node) => node.kind === kind).length;
  const sentence = !bar.length
    ? "No connectors are declared yet. Add them in the deployment code."
    : items.length
      ? `${healthy} of ${plural(bar.length, "connector")} ${healthy === 1 ? "is" : "are"} healthy. ${plural(items.length, "thing needs", "things need")} attention.`
      : bar.length === 1
        ? "The one connector is healthy. Nothing needs attention."
        : `All ${bar.length} connectors are healthy. Nothing needs attention.`;
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
    sentence,
  };
}
