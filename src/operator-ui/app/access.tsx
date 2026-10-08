import type { OperatorUiContract } from "../contract.js";
import type { OperatorState } from "../view.js";
import { Badge, StateBlock } from "./parts.js";
import { ContractState, EndpointLine } from "./overview.js";
import { mcpUrl } from "./config.js";
import { TokensPage } from "./tokens.js";

/** Keep the inbound-auth presentation independent of provider implementations. */
function accessFacts(contract: OperatorUiContract) {
  return {
    providers: contract.config.auth,
    rootTrust: contract.you.trust,
    pools: contract.you.pools.map(pool => ({
      name: pool.name, endpoint: new URL(pool.path, mcpUrl).href, trust: pool.trust,
      members: pool.grants.flatMap(grant => grant.tools === "all" ? [grant.connectorId] :
        grant.tools.map(tool => `${grant.connectorId}.${tool.name}${tool.requireReadOnly ? " (read required)" : ""}`)),
    })),
    manageTokens: contract.you.permissions.accessTokenManagement,
  };
}

export function AccessPage({ state }: { state: OperatorState }) {
  if (!state.contract) return <section><h1 id="accessHeading" tabIndex={-1}>Access</h1><ContractState state={state} /></section>;
  const facts = accessFacts(state.contract);
  return <section id="accessView"><h1 id="accessHeading" tabIndex={-1}>Access</h1><p className="meta">Inbound authentication and the endpoints admitted for your session. Access rules are configured in code.</p>
    <section className="section" aria-labelledby="inboundHeading"><h2 id="inboundHeading">Inbound auth</h2><div className="rows">{facts.providers.map((provider, index) => <div className="attention-row" key={`${provider.kind}-${index}`}><span>{provider.kind}</span><Badge>{provider.interactive ? "Interactive" : "Machine"}</Badge></div>)}</div></section>
    <section className="section" aria-labelledby="rootEndpointHeading"><div className="section-head"><h2 id="rootEndpointHeading">Root endpoint</h2><Badge>{facts.rootTrust}</Badge></div><EndpointLine url={mcpUrl} />
      <p className="meta">{facts.rootTrust === "trusted" ? "Programs may call reads and writes. Host approval controls execution." : "Programs may call reads. Writes use call_destructive_tool and host approval."}</p>
    </section>
    <section className="section" aria-labelledby="poolsHeading"><h2 id="poolsHeading">Pools</h2>{facts.pools.length ? facts.pools.map(pool => <section className="pool-panel" key={pool.name}><div className="section-head"><h3>{pool.name}</h3><Badge>{pool.trust}</Badge></div><EndpointLine url={pool.endpoint} label={pool.name} /><h4>Visible members</h4>{pool.members.length ? <ul className="pool-members">{pool.members.map(member => <li key={member}><code>{member}</code></li>)}</ul> : <p className="meta">No tools in this pool intersect your grants.</p>}</section>) : <StateBlock>No named pools are admitted for this session.</StateBlock>}</section>
    <section className="section" aria-labelledby="tokensHeading"><h2 id="tokensHeading" tabIndex={-1}>Client tokens</h2><p className="meta">Connecta issues cta_ tokens for machine clients. Each secret is shown once.</p>{facts.manageTokens ? <TokensPage state={state} embedded /> : <StateBlock>Token management is not available to this session.</StateBlock>}</section>
  </section>;
}
