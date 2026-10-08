import { ConnectorCallError } from "../../errors.js";

export type GitHubScope = ({ org: string; repo?: never } | { repo: string; org?: never }) & {
  access: "read" | "read-write";
  /** Allow edits under .github/workflows. Omitted by default. */
  workflows?: "write";
};

export interface Target { owner: string; repo: string }
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO = /^[a-z0-9_.-]{1,100}$/i;

export function target(owner: unknown, repo: unknown): Target {
  if (typeof owner !== "string" || !OWNER.test(owner) || typeof repo !== "string" ||
      !REPO.test(repo) || repo === "." || repo === "..") {
    throw new ConnectorCallError("invalid_args", "Supply an explicit GitHub owner and repository name, without URLs or path separators.");
  }
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

export function parseScopes(input: readonly GitHubScope[]): readonly GitHubScope[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw new Error("scopes to contain between 1 and 100 org or repo entries with explicit access.");
  }
  const seen = new Set<string>();
  const scopes = input.map((scope) => {
    if (!scope || (scope.org === undefined) === (scope.repo === undefined) ||
        !["read", "read-write"].includes(scope.access) ||
        (scope.workflows !== undefined && scope.workflows !== "write") ||
        (scope.workflows === "write" && scope.access !== "read-write")) {
      throw new Error("each scope to name either org or repo, explicit access, and workflows write only with read-write access.");
    }
    let normalized: GitHubScope;
    if (scope.org !== undefined) {
      if (typeof scope.org !== "string" || !OWNER.test(scope.org)) throw new Error("scope org to be a GitHub organization login.");
      normalized = { org: scope.org.toLowerCase(), access: scope.access, ...(scope.workflows ? { workflows: scope.workflows } : {}) };
    } else {
      const parts = typeof scope.repo === "string" ? scope.repo.split("/") : [];
      const parsed = target(parts[0], parts.length === 2 ? parts[1] : undefined);
      normalized = { repo: `${parsed.owner}/${parsed.repo}`, access: scope.access, ...(scope.workflows ? { workflows: scope.workflows } : {}) };
    }
    const key = normalized.org ?? normalized.repo;
    if (seen.has(key)) throw new Error("scopes without duplicate org or repo entries.");
    seen.add(key);
    return Object.freeze(normalized);
  });
  for (const scope of scopes) {
    if (!scope.repo) continue;
    const parent = scopes.find((candidate) => candidate.org === scope.repo!.split("/")[0]);
    if (parent && ((parent.access === "read" && scope.access === "read-write") ||
        (parent.workflows !== "write" && scope.workflows === "write"))) {
      throw new Error("repo scopes to narrow their org grant rather than widen it.");
    }
  }
  return Object.freeze(scopes);
}

export class ScopePolicy {
  private readonly aliases = new Map<string, GitHubScope>();
  constructor(readonly scopes: readonly GitHubScope[]) {}

  scope(t: Target, write = false, workflows = false): GitHubScope {
    const grant = this.aliases.get(`${t.owner}/${t.repo}`) ?? this.scopes.find((scope) => scope.repo === `${t.owner}/${t.repo}`) ??
      this.scopes.find((scope) => scope.org === t.owner);
    if (!grant || (write && grant.access !== "read-write") || (workflows && grant.workflows !== "write")) {
      throw new ConnectorCallError("invalid_args", `GitHub target or operation is outside configured scope. Allowed: ${this.summary()}. Workflow-file writes require workflows: "write" on the effective scope.`);
    }
    return grant;
  }

  bindAlias(t: Target, grant: GitHubScope): void {
    const name = `${t.owner}/${t.repo}`;
    // Only authenticated installation metadata can introduce an alias. Keep
    // the stricter grant when multiple configured names bind the same ID.
    const previous = this.aliases.get(name);
    if (!previous || grant.access === "read" || (previous.access === grant.access && grant.workflows !== "write")) {
      if (this.aliases.size >= 256 && !this.aliases.has(name)) this.aliases.delete(this.aliases.keys().next().value!);
      this.aliases.set(name, grant);
    }
  }

  summary(): string {
    return this.scopes.map((scope) => `${scope.org ? `org ${scope.org}` : `repo ${scope.repo}`} (${scope.access}${scope.workflows ? ", workflows write" : ""})`).join(", ");
  }

  owner(owner: unknown): string {
    if (typeof owner !== "string" || !OWNER.test(owner) ||
        !this.scopes.some((scope) => scope.org === owner.toLowerCase() || scope.repo?.split("/")[0] === owner.toLowerCase())) {
      throw new ConnectorCallError("invalid_args", `Choose a configured owner. Allowed: ${this.summary()}.`);
    }
    return owner.toLowerCase();
  }

  repositories(owner: string): string[] | undefined {
    if (this.scopes.some((scope) => scope.org === owner)) return undefined;
    return this.scopes.filter((scope) => scope.repo?.split("/")[0] === owner).map((scope) => scope.repo!.split("/")[1]!);
  }
}

/** Git paths are literal, canonical paths. Reject aliases before authentication. */
export function workflowPath(path: unknown): boolean {
  if (typeof path !== "string" || !path || path.startsWith("/") || (/[\\%]/.test(path) || Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ConnectorCallError("invalid_args", "File paths must be canonical relative Git paths without escapes or dot segments.");
  }
  const normalized = path.toLowerCase();
  return normalized === ".github" || normalized === ".github/workflows" || normalized.startsWith(".github/workflows/");
}
