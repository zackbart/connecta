import type { OperatorState } from "../view.js";
import { Badge, StateBlock } from "./parts.js";
import { ContractState, EndpointLine } from "./overview.js";
import { mcpUrl } from "./config.js";
import { TokensPage } from "./tokens.js";

export function AccessPage({ state }: { state: OperatorState }) {
  if (!state.contract)
    return (
      <section>
        <h1 id="accessHeading" tabIndex={-1}>
          Access
        </h1>
        <ContractState state={state} />
      </section>
    );
  const { config, you } = state.contract;
  return (
    <section id="accessView">
      <h1 id="accessHeading" tabIndex={-1}>
        Access
      </h1>
      <p className="meta">
        Inbound authentication and the endpoints admitted for your session. Access rules are configured in code.
      </p>
      <section className="section" aria-labelledby="inboundHeading">
        <h2 id="inboundHeading">Inbound auth</h2>
        <div className="rows">
          {config.auth.map((provider, index) => (
            <div className="attention-row" key={`${provider.kind}-${index}`}>
              <span>{provider.kind}</span>
              <Badge>{provider.interactive ? "Interactive" : "Machine"}</Badge>
            </div>
          ))}
        </div>
      </section>
      <section className="section" aria-labelledby="rootEndpointHeading">
        <div className="section-head">
          <h2 id="rootEndpointHeading">Root endpoint</h2>
          <Badge>{you.trust}</Badge>
        </div>
        <EndpointLine url={mcpUrl} />
        <p className="meta">
          {you.trust === "trusted"
            ? "Programs may call reads and writes. Host approval controls execution."
            : "Programs may call reads. Writes use call_destructive_tool and host approval."}
        </p>
      </section>
      <section className="section" aria-labelledby="poolsHeading">
        <h2 id="poolsHeading">Pools</h2>
        {you.pools.length ? (
          you.pools.map((pool) => {
            const members = pool.grants.flatMap((grant) =>
              grant.tools === "all"
                ? [grant.connectorId]
                : grant.tools.map(
                    (tool) => `${grant.connectorId}.${tool.name}${tool.requireReadOnly ? " (read required)" : ""}`,
                  ),
            );
            return (
              <section className="pool-panel" key={pool.name}>
                <div className="section-head">
                  <h3>{pool.name}</h3>
                  <Badge>{pool.trust}</Badge>
                </div>
                <EndpointLine url={new URL(pool.path, mcpUrl).href} label={pool.name} />
                <h4>Visible members</h4>
                {members.length ? (
                  <ul className="pool-members">
                    {members.map((member) => (
                      <li key={member}>
                        <code>{member}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta">No tools in this pool intersect your grants.</p>
                )}
              </section>
            );
          })
        ) : (
          <StateBlock>No named pools are admitted for this session.</StateBlock>
        )}
      </section>
      <section className="section" aria-labelledby="tokensHeading">
        <h2 id="tokensHeading" tabIndex={-1}>
          Client tokens
        </h2>
        <p className="meta">Connecta issues cta_ tokens for machine clients. Each secret is shown once.</p>
        {you.permissions.accessTokenManagement ? (
          <TokensPage state={state} embedded />
        ) : (
          <StateBlock>Token management is not available to this session.</StateBlock>
        )}
      </section>
    </section>
  );
}
