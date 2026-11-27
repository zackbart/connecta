import { monogram } from "../connection-map.js";
import { hueOf } from "../endpoints.js";

/**
 * Small glanceable marks shared by Endpoints, the matrix and Tokens. Each is
 * decorative: the text beside it, or a visually hidden one, carries the
 * meaning. Sizes and fractions are SVG attributes, never inline styles.
 */

/** A connector drawn small: a rounded square with its first letter, one tint everywhere it appears. */

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
