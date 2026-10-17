import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  mapHighlight,
  mapList,
  toolsPhrase,
  type ConnectionMap,
  type MapEdge,
  type MapNode,
} from "../connection-map.js";
import { Icon } from "./icons.js";
import { followLink, MemberChip, StateBlock } from "./parts.js";

/**
 * The connection map: callers, endpoints and connectors as an SVG flow, drawn
 * from `connectionMap()` and nothing else. Hover or focus a node to light its
 * paths; its sentence takes the legend's place. Click or Enter opens its page. The map is
 * one tab stop: arrow keys move between nodes. Narrow screens get the same
 * facts as a stacked list instead of a shrunken drawing.
 */

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function edgeClass(edge: MapEdge, lit: boolean): string {
  return classes(
    "map-edge",
    `tone-${edge.tone}`,
    edge.kind === "grant" && edge.readOnly && "read-only",
    edge.noToken && "no-token",
    lit && "lit",
  );
}

/** The drawing inside one node, positioned in the map's own coordinates. */
function NodeBody({ node }: { node: MapNode }) {
  const { x, y, width, height } = node;
  const box = <rect className="map-box" x={x} y={y} width={width} height={height} rx={11} />;
  const title = (text: string, mono = false, left = x + 46) => (
    <text className={mono ? "map-title mono" : "map-title"} x={left} y={y + 23}>
      {text}
    </text>
  );
  const detail = (text: string, left = x + 46, className = "map-detail") => (
    <text className={className} x={left} y={y + 39}>
      {text}
    </text>
  );
  if (node.kind === "person") {
    return (
      <>
        {box}
        <circle className={`map-avatar hue-${node.hue}`} cx={x + 24} cy={y + height / 2} r={13} />
        <text className="map-avatar-text" x={x + 24} y={y + height / 2 + 4} textAnchor="middle">
          {node.initials}
        </text>
        {title(node.label)}
        {detail(node.detail)}
      </>
    );
  }
  if (node.kind === "agent") {
    // The same mark the endpoint chips draw: a rounded square, not a face.
    return (
      <>
        {box}
        <rect className="map-agent-mark" x={x + 11} y={y + height / 2 - 13} width={26} height={26} rx={7} />
        <g className="map-agent-glyph" transform={`translate(${x + 16} ${y + height / 2 - 8})`}>
          <Icon name="agent" size={16} />
        </g>
        {title(node.label, true)}
        {detail(node.detail, x + 46, node.tone === "warn" ? "map-detail tone-warn" : "map-detail")}
      </>
    );
  }
  if (node.kind === "endpoint") {
    return (
      <>
        {box}
        {title(node.label, true, x + 14)}
        {node.readOnly ? (
          <>
            <rect className="map-mode read-only" x={x + width - 70} y={y + 10} width={58} height={18} rx={9} />
            <text className="map-mode-text" x={x + width - 41} y={y + 22.5} textAnchor="middle">
              read-only
            </text>
          </>
        ) : null}
        {detail(node.detail, x + 14)}
      </>
    );
  }
  return (
    <>
      {box}
      <rect className="map-tile" x={x + 11} y={y + 13} width={26} height={28} rx={7} />
      <text className="map-tile-text" x={x + 24} y={y + 31} textAnchor="middle">
        {node.initials}
      </text>
      {title(node.label)}
      {detail(node.detail, x + 46, node.tone === "ok" ? "map-detail" : `map-detail tone-${node.tone}`)}
      <circle className={`map-health tone-${node.tone}`} cx={x + width - 16} cy={y + height / 2} r={4} />
    </>
  );
}

/** A connector's read and write tools, level with it in the last column. An unknown catalog draws a muted dash. */
function ToolsBox({ node }: { node: MapNode }) {
  if (!node.toolsBox) return null;
  const { x, y, width, height } = node.toolsBox;
  if (!node.tools) {
    return (
      <>
        <rect className="map-box tools" x={x} y={y} width={width} height={height} rx={11} />
        <rect className="map-unknown" x={x + 14} y={y + height / 2 - 1.5} width={16} height={3} rx={1.5} />
      </>
    );
  }
  const total = node.tools.read + node.tools.write;
  const bar = width - 28;
  const read = total ? (bar * node.tools.read) / total : 0;
  return (
    <>
      <rect className="map-box tools" x={x} y={y} width={width} height={height} rx={11} />
      <text className="map-title" x={x + 14} y={y + 22}>
        <tspan className="map-count">{total}</tspan>
        <tspan className="map-detail" dx={5}>
          {total === 1 ? "tool" : "tools"}
        </tspan>
      </text>
      {total ? (
        <text className="map-detail" x={x + width - 14} y={y + 22} textAnchor="end">
          {`${node.tools.read} read, ${node.tools.write} write`}
        </text>
      ) : null}
      <rect className="map-bar" x={x + 14} y={y + 33} width={bar} height={6} rx={3} />
      {node.tools.read ? <rect className="map-bar read" x={x + 14} y={y + 33} width={read} height={6} rx={3} /> : null}
      {node.tools.write ? (
        <rect
          className="map-bar write"
          x={x + 14 + read + (node.tools.read ? 1.5 : 0)}
          y={y + 33}
          width={Math.max(0, bar - read - (node.tools.read ? 1.5 : 0))}
          height={6}
          rx={3}
        />
      ) : null}
    </>
  );
}

function MapNodeView({
  node,
  lit,
  dimmed,
  tabStop,
  onHover,
  onFocus,
}: {
  node: MapNode;
  lit: boolean;
  dimmed: boolean;
  /** The one node the Tab key lands on; the others take focus by arrow key. */
  tabStop: boolean;
  onHover: (id: string | null) => void;
  onFocus: (id: string | null) => void;
}) {
  const className = classes(
    "map-node",
    `kind-${node.kind}`,
    node.kind === "connector" && node.tone !== "ok" && `problem-${node.tone}`,
    node.kind === "agent" && node.tone === "warn" && "no-token",
    lit && "lit",
    dimmed && "dim",
  );
  const events = {
    onMouseEnter: () => onHover(node.id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onFocus(node.id),
    onBlur: () => onFocus(null),
  };
  const tabIndex = tabStop ? 0 : -1;
  const body = (
    <>
      <NodeBody node={node} />
      {node.kind === "connector" ? <ToolsBox node={node} /> : null}
    </>
  );
  // Every node takes focus, so the keyboard reads the same sentence a hover
  // shows. A node with a page is a link; Enter follows it.
  return node.href ? (
    <a
      className={className}
      href={node.href}
      data-node={node.id}
      tabIndex={tabIndex}
      aria-label={node.summary}
      onClick={(event) => followLink(event, node.href!)}
      {...events}
    >
      {body}
    </a>
  ) : (
    <g className={className} data-node={node.id} tabIndex={tabIndex} role="group" aria-label={node.summary} {...events}>
      {body}
    </g>
  );
}

/**
 * The node an arrow key moves to: up and down within a column, left and right
 * to the nearest node in the next column that has any, Home and End to the
 * first and last node.
 */
function nextNode(nodes: readonly MapNode[], from: MapNode, key: string): MapNode | null {
  if (key === "Home") return nodes[0] ?? null;
  if (key === "End") return nodes[nodes.length - 1] ?? null;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const column = nodes.filter((n) => n.column === from.column);
    return column[column.indexOf(from) + (key === "ArrowUp" ? -1 : 1)] ?? null;
  }
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = key === "ArrowLeft" ? -1 : 1;
  for (let column = from.column + step; column >= 0 && column <= 2; column += step) {
    const candidates = nodes.filter((n) => n.column === column);
    if (!candidates.length) continue;
    return candidates.reduce((best, n) => (Math.abs(n.y - from.y) < Math.abs(best.y - from.y) ? n : best));
  }
  return null;
}

function MapDrawing({ map }: { map: ConnectionMap }) {
  // Hover and focus are tracked apart, so leaving one never clears the
  // other; the pointer wins while both are set.
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tabStop = map.nodes.some((n) => n.id === current) ? current : (map.nodes[0]?.id ?? null);
  const active = hovered ?? focused;
  const lit = useMemo(() => (active ? mapHighlight(map, active) : null), [map, active]);
  const summary = active ? map.nodes.find((node) => node.id === active)?.summary : null;
  return (
    <div className="map-figure">
      <div className="map-canvas">
        <svg
          ref={svg}
          className={lit ? "map-svg tracing" : "map-svg"}
          viewBox={`0 0 ${map.width} ${map.height}`}
          role="group"
          aria-label="Connection map: callers, endpoints and connectors. Use the arrow keys to move between nodes."
          onKeyDown={(event: KeyboardEvent<SVGSVGElement>) => {
            const from = map.nodes.find((n) => n.id === focused);
            const to = from ? nextNode(map.nodes, from, event.key) : null;
            if (!to) return;
            event.preventDefault();
            setCurrent(to.id);
            svg.current?.querySelector<SVGElement>(`[data-node="${CSS.escape(to.id)}"]`)?.focus();
          }}
        >
          <g aria-hidden="true">
            {map.columns.map((column) => (
              <text key={column.label} className="map-column" x={column.x + 2} y={20}>
                {column.label}
                <tspan className="map-column-count" dx={6}>
                  {column.count}
                </tspan>
              </text>
            ))}
            {map.edges.map((edge) => (
              <path key={edge.id} className={edgeClass(edge, Boolean(lit?.edges.has(edge.id)))} d={edge.path} />
            ))}
            {map.nodes.flatMap((node) =>
              node.toolsBox ? (
                <path
                  key={`${node.id}>tools`}
                  className={classes("map-edge", `tone-${node.tone}`, lit?.nodes.has(node.id) && "lit")}
                  d={`M${node.x + node.width},${node.y + node.height / 2} L${node.toolsBox.x},${node.toolsBox.y + node.toolsBox.height / 2}`}
                />
              ) : (
                []
              ),
            )}
          </g>
          {map.nodes.map((node) => (
            <MapNodeView
              key={node.id}
              node={node}
              lit={Boolean(lit?.nodes.has(node.id))}
              dimmed={Boolean(lit && !lit.nodes.has(node.id))}
              tabStop={node.id === tabStop}
              onHover={setHovered}
              onFocus={(id) => {
                setFocused(id);
                if (id) setCurrent(id);
              }}
            />
          ))}
        </svg>
      </div>
      <div className="map-foot">
        {/* Not a live region: a focused node already speaks this as its name. */}
        <p id="mapTrace" className={summary ? "map-trace" : "map-trace idle"} aria-hidden="true">
          {summary ?? ""}
        </p>
        <MapLegend />
      </div>
    </div>
  );
}

function MapLegend() {
  const line = (className: string, label: string) => (
    <li>
      <svg viewBox="0 0 24 4" width="24" height="4" aria-hidden="true" focusable="false">
        <path className={`map-edge ${className}`} d="M1,2 L23,2" />
      </svg>
      {label}
    </li>
  );
  return (
    <ul className="map-legend" aria-label="Map legend">
      {line("tone-ok", "Healthy")}
      {line("tone-warn", "Attention")}
      {line("tone-danger", "Failing")}
      {line("tone-neutral read-only", "Read-only")}
      {line("tone-neutral no-token", "No token")}
      <li>
        <span className="map-swatch read" aria-hidden="true" />
        Read
      </li>
      <li>
        <span className="map-swatch write" aria-hidden="true" />
        Write
      </li>
    </ul>
  );
}

function ListLink({ node, children, className }: { node: MapNode; children: ReactNode; className?: string }) {
  return node.href ? (
    <a className={className} href={node.href} onClick={(event) => followLink(event, node.href!)}>
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

/** The narrow screen's map: each endpoint with who uses it and what it serves. */
function MapList({ map }: { map: ConnectionMap }) {
  return (
    <ul className="map-list" aria-label="Connections by endpoint">
      {mapList(map).map(({ endpoint, callers, connectors }) => (
        <li key={endpoint.id} className="map-list-entry">
          <div className="map-list-head">
            <ListLink node={endpoint} className="map-list-path">
              {endpoint.name}
            </ListLink>
            {endpoint.readOnly ? <span className="badge tag accent">read-only</span> : null}
          </div>
          {callers.length ? (
            <ul className="access-chips">
              {callers.map(({ node, noToken }) => (
                <MemberChip
                  key={node.id}
                  muted={noToken}
                  href={node.href}
                  chip={{
                    key: node.id,
                    kind: node.kind === "agent" ? "agent" : "human",
                    text: node.name,
                    initials: node.initials,
                    hue: node.hue,
                  }}
                >
                  {noToken ? <span className="map-list-note tone-warn">no token</span> : null}
                </MemberChip>
              ))}
            </ul>
          ) : null}
          {connectors.length ? (
            <ul className="map-list-items">
              {connectors.map(({ node, served }) => (
                <li key={node.id}>
                  <span className={`dot ${node.tone}`} aria-hidden="true" />
                  <ListLink node={node} className="map-list-name">
                    {node.name}
                  </ListLink>
                  <span className="map-list-note">
                    {node.tone === "ok" ? toolsPhrase(served.tools, served.write) : node.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ConnectionMapView({ map }: { map: ConnectionMap }) {
  if (!map.nodes.some((node) => node.kind === "connector")) {
    return <StateBlock title="Nothing to map yet" />;
  }
  return (
    <>
      <MapDrawing map={map} />
      <MapList map={map} />
    </>
  );
}
