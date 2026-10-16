import { useRef, useState } from "react";
import type { OperatorTool } from "../contract.js";
import type { UiToolSafety } from "../model.js";
import { Badge, StateBlock } from "./parts.js";
import { Dialog, Input, SegmentedControl } from "./primitives.js";

type CatalogRow = OperatorTool & { connectorId: string; safety?: UiToolSafety };
type Kind = "all" | "read" | "write";

/** Read or write, as the deployment resolved it. */
function ClassBadge({ classification }: { classification: OperatorTool["classification"] }) {
  return <Badge tone={classification === "read" ? "ok" : "warn"}>{classification === "read" ? "Read" : "Write"}</Badge>;
}

/** What the host does before a call, and what the tool says about itself. */
function SafetyBadges({ tool }: { tool: CatalogRow }) {
  return (
    <>
      {tool.safety === "needs_approval" ? <Badge>Asks first</Badge> : null}
      {tool.annotations?.destructiveHint ? <Badge tone="danger">Destructive</Badge> : null}
      {tool.annotations?.openWorldHint ? <Badge>Open world</Badge> : null}
    </>
  );
}

export function Catalog({ tools }: { tools: CatalogRow[] }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [selected, setSelected] = useState<CatalogRow | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const q = query.trim().toLowerCase();
  const visible = tools.filter(
    (t) =>
      (kind === "all" || t.classification === kind) &&
      [t.address, t.description, t.connectorId].some((value) => value?.toLowerCase().includes(q)),
  );
  const writes = tools.filter((t) => t.classification === "write").length;
  const kinds = [
    { value: "all", label: "All", count: tools.length },
    { value: "read", label: "Read", count: tools.length - writes },
    { value: "write", label: "Write", count: writes },
  ] as const;
  return (
    <div className="collection catalog">
      {tools.length ? (
        <div className="catalog-toolbar">
          <Input
            type="search"
            className="filter"
            aria-label="Filter tools"
            placeholder="Search tools"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <SegmentedControl label="Tool classification" value={kind} options={kinds} onChange={setKind} />
        </div>
      ) : null}
      {visible.length ? (
        <ul className="tool-list card" aria-label="Tool catalog">
          {visible.map((tool) => (
            <li key={tool.address} className="tool-row">
              <div className="tool-row-main">
                <button
                  type="button"
                  className="tool-name"
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    setSelected(tool);
                  }}
                >
                  <code>{tool.address}</code>
                </button>
                {tool.description ? <p className="tool-description">{tool.description}</p> : null}
              </div>
              <div className="tool-row-badges">
                <SafetyBadges tool={tool} />
                <ClassBadge classification={tool.classification} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <StateBlock>{tools.length ? "No tools match these filters." : "No live tools."}</StateBlock>
      )}
      <Dialog
        drawer
        returnFocusTo={returnFocus}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected?.address ?? "Tool schema"}
        description="Tool schema"
      >
        {selected ? (
          <div className="schema-drawer">
            <div className="schema-badges">
              <ClassBadge classification={selected.classification} />
              <SafetyBadges tool={selected} />
            </div>
            {selected.description ? <p className="schema-description">{selected.description}</p> : null}
            <SchemaBlock title="Input schema" value={selected.inputSchema} />
            <SchemaBlock title="Output schema" value={selected.outputSchema} />
            {selected.annotations ? <SchemaBlock title="Annotations" value={selected.annotations} /> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function SchemaBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="schema-block">
      <h3>{title}</h3>
      {value ? <pre className="schema-code">{JSON.stringify(value, null, 2)}</pre> : <p className="meta">None</p>}
    </section>
  );
}
