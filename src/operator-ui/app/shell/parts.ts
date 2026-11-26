import type { Html } from "@effect/ui/html";
import type { Notice } from "../../view.js";

export const StateBlockBusy = <M>(h: Html.H<M>, id: string, copy: string) =>
  h.div
    .class("state-block", "busy")
    .attr("role", "status")
    .attr("id", id)
    .children(h.span.class("spinner").attr("aria-hidden", "true"), h.p.class("state-copy").children(copy));

export const NoticeLine = <M>(h: Html.H<M>, id: string, notice: Notice | null) =>
  h.p
    .attr("id", id)
    .class("notice", notice?.tone === "error" && "error-notice")
    .attr("role", notice?.tone === "error" ? "alert" : "status")
    .attr("aria-live", "polite")
    .attr("tabindex", "-1")
    .children(notice ? notice.message : "");
