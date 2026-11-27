import { Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import { pageDescription, PAGE_META, type OperatorState } from "../../view.js";
import { productDescription } from "../config.js";
import { ContractState, ContractStateView, contractLoading, contractStateView } from "../components/contract-state.js";
import { keepSameContractState } from "../components/projection.js";
import { PageSkeleton } from "../components/skeletons.js";
import { RetryOperatorLoad } from "./connector-commands.js";

export const PendingData = Schema.Struct({
  page: Schema.Literals(["overview", "endpoints", "settings", "connector", "tokens", "connections", "activity"]),
  loading: Schema.Boolean,
  contract: ContractStateView,
});
export type PendingData = typeof PendingData.Type;

export const pendingProjection = () => {
  const contract = keepSameContractState();
  let last: PendingData | null = null;
  return (state: OperatorState): PendingData => {
    const next = { page: state.page, loading: contractLoading(state), contract: contract(contractStateView(state)) };
    if (last && last.page === next.page && last.loading === next.loading && last.contract === next.contract)
      return last;
    return (last = next);
  };
};

const PendingMessage = UiSchema.TaggedEnum({ ClickedRetryLoad: {} });

export const PendingPageNoDeps = Html.component({
  name: "PendingPage",
  props: Schema.Struct({ data: PendingData }),
  model: Schema.Null,
  message: PendingMessage,
  restore: false,
}).make({
  init: () => null,
  update: { ClickedRetryLoad: ($) => $.run(RetryOperatorLoad.make()) },
  view: (h) => {
    const { page, loading, contract } = h.props.data;
    return h.section
      .attr("id", "rolePending")
      .attr("aria-busy", loading ? "true" : "false")
      .children(
        h.div
          .class("page-heading")
          .children(
            h.div.children(
              h.h1.attr("id", `${page}Heading`).attr("tabindex", "-1").children(PAGE_META[page].label),
              h.p.class("meta").children(pageDescription(page, productDescription)),
            ),
          ),
        loading ? PageSkeleton(h) : ContractState(h, contract, PendingMessage.ClickedRetryLoad()),
      );
  },
});

export const PendingPage = PendingPageNoDeps.pipe(Component.provide([RetryOperatorLoad.layer]));
