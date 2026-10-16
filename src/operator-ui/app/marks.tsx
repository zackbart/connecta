import { monogram } from "../connection-map.js";
import { hueOf, initialsOf } from "../endpoints.js";
import { actorLabel, actorStableId, type UiActivityActor } from "../view.js";
import { MemberMark } from "./parts.js";
import { Icon } from "./icons.js";

/**
 * Small glanceable marks shared by Endpoints, the matrix and Tokens. Each is
 * decorative: the text beside it, or a visually hidden one, carries the
 * meaning. Sizes and fractions are SVG attributes, never inline styles.
 */

/**
 * A connector's colored initial. One connector keeps one tint everywhere. The
 * letter is drawn by CSS, so the connector's name stays the only text beside it.
 */
export function Monogram({ id, title, size = "md" }: { id: string; title: string; size?: "sm" | "md" }) {
  return (
    <span
      className={`monogram ${size} hue-${hueOf(`connector:${id}`)}`}
      data-letter={(title.trim()[0] ?? id[0] ?? "?").toUpperCase()}
      aria-hidden="true"
    />
  );
}

/** An agent's square mark at row size, where a person has a round avatar. */
export function AgentMark() {
  return (
    <span className="agent-mark md" aria-hidden="true">
      <Icon name="agent" size={12} />
    </span>
  );
}

/** Read tools then write tools as one bar. An empty bar is a track alone. */
export function SplitBar({ read, write }: { read: number; write: number }) {
  const total = read + write;
  const readWidth = total ? (read / total) * 100 : 0;
  return (
    <svg className="split-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="split-track" width="100" height="6" />
      {read ? <rect className="split-read" width={readWidth} height="6" /> : null}
      {write ? <rect className="split-write" x={readWidth} width={100 - readWidth} height="6" /> : null}
    </svg>
  );
}

/** A pie: full is everything, a slice is part, an empty ring is nothing. */
export function SharePie({ share }: { share: number | null }) {
  const r = 7;
  const c = 8;
  let slice = null;
  if (share !== null && share >= 0.999) slice = <circle className="share-fill" cx={c} cy={c} r={r} />;
  else if (share !== null && share > 0) {
    const angle = share * 2 * Math.PI;
    const x = c + r * Math.sin(angle);
    const y = c - r * Math.cos(angle);
    slice = (
      <path
        className="share-fill"
        d={`M${c} ${c}V${c - r}A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`}
      />
    );
  }
  return (
    <svg
      className={share === null ? "share-pie unknown" : "share-pie"}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="share-track" cx={c} cy={c} r={r} />
      {slice}
    </svg>
  );
}

/**
 * Who and what, drawn small: a connector's monogram and a caller's chip. A
 * connector is a rounded square with its first letter, a person a round
 * avatar, an agent a square agent glyph, so the three never read alike. Each
 * keeps one tint everywhere it appears.
 */

export function ConnectorMark({
  id,
  title,
  size,
  hue,
}: {
  id: string;
  title: string;
  size?: "sm" | "lg";
  /** A page that lists a handful side by side can hand out tints in order, so none repeat. */
  hue?: number;
}) {
  return (
    <span
      className={`connector-mark avatar hue-${(hue ?? hueOf(`connector:${id}`)) % 6}${size ? ` ${size}` : ""}`}
      aria-hidden="true"
    >
      {monogram(title || id)}
    </span>
  );
}

type ActorShape =
  | { kind: "human"; text: string; initials: string; hue: number }
  | { kind: "agent" | "other"; text: string };

/** A caller as a chip reads it: an agent token by agent name, a person by label or id, anything else by kind. */
function actorShape(actor?: UiActivityActor): ActorShape {
  const name = actor?.label || actor?.id;
  if (actor?.kind === "access_token" && name) return { kind: "agent", text: name };
  if (actor?.kind && actor.id && name) {
    // The same key the endpoint chips use, so a person keeps one color.
    const key = actor.namespace ? `${actor.namespace}:${actor.id}` : actor.id;
    return { kind: "human", text: name, initials: initialsOf(name), hue: hueOf(key) };
  }
  return { kind: "other", text: actorLabel(actor) };
}

export function ActorChip({ actor }: { actor?: UiActivityActor | undefined }) {
  const shape = actorShape(actor);
  const stable = actorStableId(actor);
  return (
    <span
      className={`actor-chip ${shape.kind}`}
      title={stable ? `${actorLabel(actor)} · ${stable}` : actorLabel(actor)}
    >
      {shape.kind === "other" ? (
        <span className="actor-unknown" aria-hidden="true">
          <Icon name="user" size={11} />
        </span>
      ) : (
        <MemberMark chip={shape.kind === "human" ? shape : { kind: "agent", initials: "", hue: 0 }} />
      )}
      <span className="actor-chip-text">{shape.text}</span>
    </span>
  );
}
