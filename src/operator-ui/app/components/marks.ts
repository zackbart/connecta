import type { Html } from "@effect/ui/html";
import { monogram } from "../../connection-map.js";
import { hueOf, initialsOf } from "../../endpoints.js";
import { actorLabel, actorStableId, type UiActivityActor } from "../../view.js";
import { Icon } from "./icons.js";
import { MemberMark } from "./parts.js";

export const decorative: Readonly<Record<string, string>> = { "aria-hidden": "true", focusable: "false" };

export const Monogram = <M>(h: Html.H<M>, id: string, title: string, size: "sm" | "md" = "md") =>
  h.span
    .class("monogram", size, `hue-${hueOf(`connector:${id}`)}`)
    .attr("data-letter", (title.trim()[0] ?? id[0] ?? "?").toUpperCase())
    .attr("aria-hidden", "true");

const R = 7;
const C = 8;

const slice = <M>(h: Html.H<M>, share: number | null) => {
  if (share === null || share <= 0) return null;
  if (share >= 0.999) return h.el("circle").attrs({ class: "share-fill", cx: String(C), cy: String(C), r: String(R) });
  const angle = share * 2 * Math.PI;
  const x = C + R * Math.sin(angle);
  const y = C - R * Math.cos(angle);
  return h.el("path").attrs({
    class: "share-fill",
    d: `M${C} ${C}V${C - R}A${R} ${R} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`,
  });
};

export const SharePie = <M>(h: Html.H<M>, share: number | null) =>
  h
    .el("svg")
    .attrs({
      class: share === null ? "share-pie unknown" : "share-pie",
      viewBox: "0 0 16 16",
      width: "16",
      height: "16",
      "aria-hidden": "true",
      focusable: "false",
    })
    .children(
      h.el("circle").attrs({ class: "share-track", cx: String(C), cy: String(C), r: String(R) }),
      slice(h, share),
    );

export const EndpointName = <M>(h: Html.H<M>, pool: string | null, label: string) =>
  pool === null ? h.span.class("endpoint-title").children(label) : h.code.children(label);

export const RunsAs = <M>(h: Html.H<M>, label: string) => {
  const at = label.indexOf(" · ");
  return at < 0 ? [label] : [h.span.class("runs-as-kind").children(label.slice(0, at)), label.slice(at)];
};

export const AgentMark = <M>(h: Html.H<M>) =>
  h.span
    .class("agent-mark", "md")
    .attr("aria-hidden", "true")
    .children(Icon(h, "agent", 12));

export const SplitBar = <M>(h: Html.H<M>, read: number, write: number) => {
  const total = read + write;
  const readWidth = total ? (read / total) * 100 : 0;
  return h.svg
    .class("split-bar")
    .attrs({ viewBox: "0 0 100 6", preserveAspectRatio: "none" })
    .attrs(decorative)
    .children(
      h.rect.class("split-track").attrs({ width: "100", height: "6" }),
      read ? h.rect.class("split-read").attrs({ width: String(readWidth), height: "6" }) : null,
      write
        ? h.rect.class("split-write").attrs({ x: String(readWidth), width: String(100 - readWidth), height: "6" })
        : null,
    );
};

export const ConnectorMark = <M>(h: Html.H<M>, id: string, title: string, size?: "sm" | "lg", hue?: number) =>
  h.span
    .class("connector-mark", "avatar", `hue-${(hue ?? hueOf(`connector:${id}`)) % 6}`, size)
    .attr("aria-hidden", "true")
    .children(monogram(title || id));

type ActorShape =
  | { readonly kind: "human"; readonly text: string; readonly initials: string; readonly hue: number }
  | { readonly kind: "agent" | "other"; readonly text: string };

function actorShape(actor?: UiActivityActor): ActorShape {
  const name = actor?.label || actor?.id;
  if (actor?.kind === "access_token" && name) return { kind: "agent", text: name };
  if (actor?.kind && actor.id && name) {
    const key = actor.namespace ? `${actor.namespace}:${actor.id}` : actor.id;
    return { kind: "human", text: name, initials: initialsOf(name), hue: hueOf(key) };
  }
  return { kind: "other", text: actorLabel(actor) };
}

export const ActorChip = <M>(h: Html.H<M>, actor: UiActivityActor | undefined) => {
  const shape = actorShape(actor);
  const stable = actorStableId(actor);
  return h.span
    .class("actor-chip", shape.kind)
    .attr("title", stable ? `${actorLabel(actor)} · ${stable}` : actorLabel(actor))
    .children(
      shape.kind === "other"
        ? h.span
            .class("actor-unknown")
            .attr("aria-hidden", "true")
            .children(Icon(h, "user", 11))
        : MemberMark(h, shape.kind === "human" ? shape : { kind: "agent", initials: "", hue: 0 }),
      h.span.class("actor-chip-text").children(shape.text),
    );
};
