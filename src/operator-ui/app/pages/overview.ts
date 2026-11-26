import { Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Predicate, Schema } from "effect";
import { connectionMap, type ConnectionMap, type MapNode } from "../../connection-map.js";
import type { OperatorUiContractV2 } from "../../contract.js";
import { fixPrompt } from "../../fix-prompts.js";
import { shownHealth, type SteadyHealth } from "../../health.js";
import { attentionItems, overviewHeadline, type AttentionItem, type OverviewHeadline } from "../../overview.js";
import { pageForPath, type OperatorState } from "../../view.js";
import {
  ContractState,
  ContractStateView,
  contractLoading,
  contractStateView,
  maintainerContract,
} from "../components/contract-state.js";
import { CopyButton } from "../components/copy-button.js";
import { Icon } from "../components/icons.js";
import { Card, MemberMark, PageLink, Pill } from "../components/parts.js";
import { OverviewSkeleton, PendingLine, Skeleton } from "../components/skeletons.js";
import { NavigateToPage, RetryLoad } from "../shell/commands.js";
import { HostConnectionMap } from "../shell/island.js";

const opaque = <A>(name: string) =>
  Schema.declare<A>((input): input is A => Predicate.isObject(input), { identifier: name });

export const OverviewData = UiSchema.TaggedEnum({
  Loading: {},
  Contract: { contract: ContractStateView },
  Ready: {
    headline: opaque<OverviewHeadline>("OverviewHeadline"),
    items: opaque<ReadonlyArray<AttentionItem>>("AttentionItems"),
    callers: opaque<ReadonlyArray<MapNode>>("MapCallers"),
    map: opaque<ConnectionMap>("ConnectionMap"),
  },
});
export type OverviewData = typeof OverviewData.Type;

type Ready = Extract<OverviewData, { readonly _tag: "Ready" }>;

const readyFor = (contract: OperatorUiContractV2, steady: SteadyHealth, tokensPage: boolean): Ready => {
  const shown = shownHealth(contract, steady);
  const options = { signals: shown.signals, tokensPage };
  const map = connectionMap(shown.contract!, options);
  const items = attentionItems(shown.contract!, options);
  return OverviewData.Ready({
    headline: overviewHeadline(shown.contract!, map, items, shown.signals),
    items,
    callers: map.nodes.filter((node) => node.column === 0),
    map,
  }) as Ready;
};

export const overviewProjection = () => {
  let last: { contract: OperatorUiContractV2; steady: SteadyHealth; tokensPage: boolean; ready: Ready } | null = null;
  return (state: OperatorState, steady: SteadyHealth): OverviewData => {
    const contract = maintainerContract(state);
    if (!contract) {
      return contractLoading(state)
        ? OverviewData.Loading()
        : OverviewData.Contract({ contract: contractStateView(state) });
    }
    const tokensPage = state.data?.accessTokenManagement === "available";
    if (last?.contract !== contract || last.steady !== steady || last.tokensPage !== tokensPage) {
      last = { contract, steady, tokensPage, ready: readyFor(contract, steady, tokensPage) };
    }
    return last.ready;
  };
};

const OverviewMessage = UiSchema.TaggedEnum({
  ClickedLink: { href: Schema.String },
  ClickedRetryLoad: {},
});

type H = Html.H<typeof OverviewMessage.Type>;

const follow = (href: string) => OverviewMessage.ClickedLink({ href });

const Legend = (h: H, entries: ReadonlyArray<readonly [tone: string, count: number, label: string]>) =>
  h.ul
    .class("stat-legend")
    .children(
      entries
        .filter(([, count]) => count > 0)
        .map(([tone, count, label]) =>
          h.li
            .key(label)
            .children(h.span.class("dot", ...tone.split(" ")).attr("aria-hidden", "true"), String(count), " ", label),
        ),
    );

const StatHead = (h: H, label: string, href?: string) =>
  h.div.class("stat-head").children(
    h.h2.class("stat-label").children(label),
    href
      ? PageLink(h, href, follow)
          .class("stat-link")
          .attr("aria-label", `View ${label.toLowerCase()}`)
          .children(Icon(h, "back", 14))
      : null,
  );

const Stats = (h: H, headline: OverviewHeadline, callers: ReadonlyArray<MapNode>) => {
  const shown = callers.slice(0, 8);
  const readWrite = headline.endpoints - headline.readOnlyEndpoints;
  return h.div.class("overview-stats").children(
    Card(h, {
      className: "overview-stat",
      label: "Connectors",
      children: [
        StatHead(h, "Connectors", "/connectors"),
        h.p
          .class("stat-number")
          .children(
            headline.connectors
              ? [
                  headline.pending === headline.connectors ? Skeleton(h, "xs") : String(headline.healthy),
                  h.span.class("stat-of").children("/", String(headline.connectors)),
                ]
              : "0",
          ),
        h.div
          .class("stat-bar")
          .attr("aria-hidden", "true")
          .children(
            headline.bar.length
              ? headline.bar.map((entry) =>
                  h.span.key(entry.id).class(`tone-${entry.tone}`).attr("title", `${entry.title}: ${entry.label}`),
                )
              : h.span,
          ),
        Legend(h, [
          ["ok", headline.healthy, "healthy"],
          ["warn", headline.warn, "attention"],
          ["danger", headline.danger, "failing"],
          ["neutral", headline.pending, "checking"],
        ]),
      ],
    }),
    Card(h, {
      className: "overview-stat",
      label: "Endpoints",
      children: [
        StatHead(h, "Endpoints", "/endpoints"),
        h.p.class("stat-number").children(String(headline.endpoints)),
        h.div
          .class("stat-bar")
          .attr("aria-hidden", "true")
          .children(
            Array.from({ length: headline.endpoints }, (_, index) =>
              h.span
                .key(String(index))
                .class(index < headline.readOnlyEndpoints ? "mode-read-only" : "mode-read-write"),
            ),
          ),
        Legend(h, [
          ["read-only", headline.readOnlyEndpoints, "read-only"],
          ["read-write", readWrite, "read-write"],
        ]),
      ],
    }),
    Card(h, {
      className: "overview-stat",
      label: "People · Agents",
      children: [
        StatHead(h, "People · Agents"),
        h.p
          .class("stat-number")
          .children(String(headline.people), h.span.class("stat-of").children(" · "), String(headline.agents)),
        shown.length
          ? h.ul
              .class("stat-callers")
              .attr("aria-hidden", "true")
              .children(
                shown.map((node) =>
                  h.li
                    .key(node.id)
                    .attr("title", node.name)
                    .children(
                      MemberMark(
                        h,
                        { kind: node.kind === "agent" ? "agent" : "human", initials: node.initials, hue: node.hue },
                        node.kind === "agent" && node.tone === "warn",
                      ),
                    ),
                ),
                callers.length > shown.length
                  ? h.li
                      .key("more")
                      .class("stat-more")
                      .children("+", String(callers.length - shown.length))
                  : null,
              )
          : null,
      ],
    }),
  );
};

const AttentionRow = (h: H, item: AttentionItem) => {
  const subject = item.kind === "agent" ? h.code.children(item.subject) : item.subject;
  const icon = item.kind === "agent" ? "key" : item.tone === "danger" ? "alert" : "plug";
  return h.li
    .key(item.key)
    .class("attention-item")
    .attr("data-attention", item.key)
    .children(
      h.span
        .class("attention-icon", `tone-${item.tone}`)
        .attr("aria-hidden", "true")
        .children(Icon(h, icon, 15)),
      h.div
        .class("attention-text")
        .children(
          h.h3
            .attr("title", `${item.subject} ${item.problem}`)
            .children(
              item.href
                ? PageLink(h, item.href, follow)
                    .attr("title", item.subject)
                    .attr("aria-label", item.subject)
                    .children(subject)
                : subject,
              " ",
              item.problem,
            ),
          h.p.attr("title", item.body).children(item.body),
        ),
      h.div.class("attention-actions").children(
        item.fix
          ? CopyButton(h, {
              key: item.key,
              props: {
                value: fixPrompt(item.fix.kind, item.fix.connectorId),
                label: "Copy fix prompt",
                className: "btn sm quiet",
                ariaLabel: `Copy fix prompt for ${item.subject}`,
              },
            })
          : null,
        item.action
          ? PageLink(h, item.action.href, follow)
              .class("btn", "sm")
              .attr("aria-label", item.action.ariaLabel)
              .children(item.action.label)
          : null,
      ),
    );
};

const Attention = (h: H, items: ReadonlyArray<AttentionItem>, pending: number) =>
  Card(h, {
    className: "overview-section overview-attention",
    title: "Needs attention",
    titleId: "attentionHeading",
    children: [
      items.length
        ? h.ul
            .class("attention-list")
            .attr("aria-labelledby", "attentionHeading")
            .children(items.map((item) => AttentionRow(h, item)))
        : null,
      pending
        ? PendingLine(h, ["Checking ", String(pending), " ", pending === 1 ? "connector" : "connectors", "…"])
        : items.length
          ? null
          : h.div
              .class("attention-clear")
              .attr("role", "status")
              .children(
                h.span
                  .class("attention-icon", "tone-ok")
                  .attr("aria-hidden", "true")
                  .children(Icon(h, "check", 15)),
                h.h3.children("All clear"),
              ),
    ],
  });

const Status = (h: H, { headline, items }: Ready) => {
  const pending = headline.pending > 0;
  if (!items.length && pending) return Pill(h, "neutral", "Checking");
  if (!items.length) {
    const unverified = headline.bar.some((entry) => entry.tone === "neutral");
    return unverified ? Pill(h, "neutral", "No attention needed") : Pill(h, "healthy", "All healthy");
  }
  const failing = items.some((item) => item.tone === "danger");
  return Pill(h, failing ? "error" : "attention", [
    String(items.length),
    " ",
    items.length === 1 ? "needs" : "need",
    " attention",
  ]);
};

export const OverviewPageNoDeps = Html.component({
  name: "OverviewPage",
  props: Schema.Struct({ overview: OverviewData }),
  model: Schema.Null,
  message: OverviewMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    ClickedLink: ($, { href }) => $.run(NavigateToPage.make({ page: pageForPath(href.replace(/[?#].*$/, "")), href })),
    ClickedRetryLoad: ($) => $.run(RetryLoad.make()),
  },
  view: (h) => {
    const { overview } = h.props;
    return h.section.attr("id", "overviewView").children(
      h.div
        .class("page-heading")
        .children(
          h.div
            .class("overview-title")
            .children(
              h.h1.attr("id", "overviewHeading").attr("tabindex", "-1").children("Overview"),
              overview._tag === "Ready" && overview.headline.connectors ? Status(h, overview) : null,
            ),
        ),
      OverviewData.match(overview, {
        Loading: () => OverviewSkeleton(h),
        Contract: ({ contract }) => ContractState(h, contract, OverviewMessage.ClickedRetryLoad()),
        Ready: ({ headline, items, callers, map }) => [
          Stats(h, headline, callers),
          Attention(h, items, headline.pending),
          Card(h, {
            className: "overview-section overview-map",
            title: "Who reaches what",
            titleId: "mapHeading",
            children: [h.div.class("island").onMount(HostConnectionMap({ map }))],
          }),
        ],
      }),
    );
  },
});

export const OverviewPage = OverviewPageNoDeps.pipe(Component.provide([NavigateToPage.layer, RetryLoad.layer]));
