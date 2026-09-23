/**
 * Client setup snippets for one MCP endpoint: the deployment's `/mcp` or a
 * `/mcp/<pool>`. Three formats and no more — Claude Code's CLI, Codex's CLI,
 * and the `mcpServers` JSON most other clients read — because a longer list
 * is a list to keep current.
 *
 * None of them carries a credential. A client authenticates through the
 * deployment's inbound auth — OAuth discovery where that is configured — and
 * a token pasted into a snippet on this page would be one rendered by it.
 */

export interface ClientSetupCommand {
  id: "claude" | "codex" | "json";
  label: string;
  text: string;
}

/**
 * The name a client files this server under. Derived from the deployment's
 * configured server name, reduced to the characters every client CLI accepts
 * unquoted, with the pool appended so two endpoints never collide.
 */
export function clientServerName(serverName: string | undefined, pool?: string): string {
  const base =
    (serverName ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "connecta";
  return pool ? `${base}-${pool}` : base;
}

/** The URL for a pool: `/mcp` plus its name, which config limits to `[a-z0-9_-]`. */
export function poolEndpointUrl(mcpUrl: string, pool: string): string {
  return `${mcpUrl.replace(/\/+$/, "")}/${encodeURIComponent(pool)}`;
}

/** POSIX single-quoting, only when the value needs it. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,~-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function clientSetupCommands(name: string, url: string): ClientSetupCommand[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      text: `claude mcp add --transport http ${shellWord(name)} ${shellWord(url)}`,
    },
    {
      id: "codex",
      label: "Codex",
      text: `codex mcp add ${shellWord(name)} --url ${shellWord(url)}`,
    },
    {
      id: "json",
      label: "JSON config",
      text: JSON.stringify(
        { mcpServers: { [name]: { type: "http", url } } },
        null,
        2,
      ),
    },
  ];
}
