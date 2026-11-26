import type { Html } from "@effect/ui/html";
import { Card } from "./parts.js";

type Width = "xs" | "sm" | "md" | "lg" | "full";

export const Skeleton = <M>(h: Html.H<M>, width: Width = "md", className?: string) =>
  h.span.class("skeleton", `w-${width}`, className).attr("aria-hidden", "true");

const LoadingNote = <M>(h: Html.H<M>) =>
  h.p.class("visually-hidden").attr("role", "status").children("Loading configuration…");

const StatSkeleton = <M>(h: Html.H<M>, label: string) =>
  Card(h, {
    className: "overview-stat",
    label,
    children: [
      h.div.class("stat-head").children(h.h2.class("stat-label").children(label)),
      h.p.class("stat-number").children(Skeleton(h, "sm")),
      h.div.class("stat-bar").attr("aria-hidden", "true").children(h.span.class("skeleton")),
      h.ul
        .class("stat-legend")
        .attr("aria-hidden", "true")
        .children(h.li.children(Skeleton(h, "md"))),
    ],
  });

export const PendingLine = <M>(h: Html.H<M>, text: ReadonlyArray<string>) =>
  h.div
    .class("attention-pending")
    .attr("role", "status")
    .children(
      h.span.class("attention-icon").attr("aria-hidden", "true").children(h.span.class("spinner")),
      h.h3.children(text),
    );

export const OverviewSkeleton = <M>(h: Html.H<M>) =>
  h.div.attr("aria-busy", "true").children(
    LoadingNote(h),
    h.div
      .class("overview-stats")
      .children(StatSkeleton(h, "Connectors"), StatSkeleton(h, "Endpoints"), StatSkeleton(h, "People · Agents")),
    Card(h, {
      className: "overview-section overview-attention",
      title: "Needs attention",
      titleId: "attentionHeading",
      children: [
        h.div
          .class("attention-pending")
          .attr("aria-hidden", "true")
          .children(h.span.class("attention-icon", "skeleton"), Skeleton(h, "lg")),
      ],
    }),
    Card(h, {
      className: "overview-section overview-map",
      title: "Who reaches what",
      titleId: "mapHeading",
      children: [h.div.class("skeleton", "skeleton-map").attr("aria-hidden", "true")],
    }),
  );
