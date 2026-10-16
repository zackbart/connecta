import { hueOf } from "../endpoints.js";
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
