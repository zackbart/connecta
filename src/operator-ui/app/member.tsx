import { useRef, useState } from "react";
import type { OperatorState } from "../view.js";
import { clientServerName } from "../setup-commands.js";
import { productName } from "./config.js";
import { StateBlock } from "./parts.js";
import { Button } from "./primitives.js";
import { ClientSetupDialog, EndpointLine, endpointUrl, type SetupTarget } from "./endpoints.js";

/**
 * A pool member's page until UI-3 builds the real one: their pools, each
 * with its URL and client setup, and nothing else. The member contract
 * carries no config, agents, matrix or other members, and this page reads
 * none of its other fields either.
 */
export function MemberPage({ state }: { state: OperatorState }) {
  const [setup, setSetup] = useState<SetupTarget | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pools = state.contract?.role === "member" ? state.contract.pools : [];
  return (
    <section id="memberView">
      <div className="page-heading">
        <div>
          <h1 id="endpointsHeading" tabIndex={-1}>
            Your endpoints
          </h1>
          <p className="meta">Connect an MCP client to an endpoint you're a member of.</p>
        </div>
      </div>
      {pools.length ? (
        <div className="endpoint-table" aria-label="Your endpoints">
          {pools.map((pool) => {
            const url = endpointUrl(pool.humanPath);
            return (
              <section className="endpoint-entry member-entry" key={pool.name} aria-label={pool.humanPath}>
                <div className="endpoint-columns">
                  <div className="endpoint-name">
                    <span className="endpoint-title">
                      <code>{pool.humanPath}</code>
                      <span className="meta">{pool.name}</span>
                    </span>
                    <EndpointLine url={url} label={pool.name} />
                  </div>
                  <Button
                    variant="quiet"
                    className="endpoint-setup"
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget;
                      setSetup({
                        label: pool.name,
                        path: pool.humanPath,
                        url,
                        name: clientServerName(productName, pool.name),
                      });
                    }}
                    aria-label={`Client setup for ${pool.name}`}
                  >
                    Client setup
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <StateBlock>You aren't a member of any endpoint yet.</StateBlock>
      )}
      <ClientSetupDialog target={setup} onClose={() => setSetup(null)} returnFocus={returnFocus} />
    </section>
  );
}
