import { Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import { configSummary, type ConfigSummary } from "../../config-summary.js";
import type { OperatorUiContractV2 } from "../../contract.js";
import { accessChips, type AccessChip } from "../../endpoints.js";
import type { OperatorState } from "../../view.js";
import {
  DefaultLimits,
  FactChips,
  FeatureTiles,
  OverrideChips,
  SignInTiles,
  StatTiles,
  TileSection,
} from "../components/config-tiles.js";
import {
  ContractState,
  ContractStateView,
  contractStateView,
  maintainerContract,
} from "../components/contract-state.js";
import { Icon } from "../components/icons.js";
import { opaque } from "../components/projection.js";
import { RetryLoad } from "../shell/commands.js";

export const SettingsData = UiSchema.TaggedEnum({
  Contract: { contract: ContractStateView },
  Ready: {
    summary: opaque<ConfigSummary>("ConfigSummary"),
    maintainers: opaque<ReadonlyArray<AccessChip>>("Maintainers"),
  },
});
export type SettingsData = typeof SettingsData.Type;

export const settingsProjection = () => {
  let last: { contract: OperatorUiContractV2; ready: SettingsData } | null = null;
  return (state: OperatorState): SettingsData => {
    const contract = maintainerContract(state);
    if (!contract?.config || !contract.root) return SettingsData.Contract({ contract: contractStateView(state) });
    if (last?.contract !== contract) {
      last = {
        contract,
        ready: SettingsData.Ready({
          summary: configSummary(contract.config, contract.configSources ?? {}),
          maintainers: accessChips(contract.root.maintainers),
        }),
      };
    }
    return last.ready;
  };
};

const SettingsMessage = UiSchema.TaggedEnum({ ClickedRetryLoad: {} });

type H = Html.H<typeof SettingsMessage.Type>;

const Board = (h: H, summary: ConfigSummary, maintainers: ReadonlyArray<AccessChip>) =>
  h.div.class("settings-board").children(
    TileSection(h, { id: "deploymentHeading", title: "Deployment", children: [FactChips(h, summary.deployment)] }),
    TileSection(h, {
      id: "signInHeading",
      title: "Sign-in",
      children: [SignInTiles(h, summary.signIn, maintainers)],
    }),
    TileSection(h, { id: "featuresHeading", title: "Features", children: [FeatureTiles(h, summary.features)] }),
    TileSection(h, {
      id: "limitsHeading",
      title: "Limits",
      children: [StatTiles(h, { tiles: summary.limits, label: "Limits" }), DefaultLimits(h, summary.defaults)],
    }),
    summary.overrides.length
      ? TileSection(h, {
          id: "overridesHeading",
          title: "Overrides",
          children: [OverrideChips(h, summary.overrides)],
        })
      : null,
    summary.other.length
      ? TileSection(h, {
          id: "otherHeading",
          title: "Other",
          children: [StatTiles(h, { tiles: summary.other, label: "Other settings", compact: true })],
        })
      : null,
  );

export const SettingsPageNoDeps = Html.component({
  name: "SettingsPage",
  props: Schema.Struct({ settings: SettingsData }),
  model: Schema.Null,
  message: SettingsMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    ClickedRetryLoad: ($) => $.run(RetryLoad.make()),
  },
  view: (h) =>
    h.section.attr("id", "settingsView").children(
      h.div
        .class("page-heading")
        .children(
          h.div
            .class("settings-title")
            .children(
              h.h1.attr("id", "settingsHeading").attr("tabindex", "-1").children("Settings"),
              h.span.class("code-tag").children(Icon(h, "lock", 12), "Defined in code"),
            ),
        ),
      SettingsData.match(h.props.settings, {
        Contract: ({ contract }) => ContractState(h, contract, SettingsMessage.ClickedRetryLoad()),
        Ready: ({ summary, maintainers }) => Board(h, summary, maintainers),
      }),
    ),
});

export const SettingsPage = SettingsPageNoDeps.pipe(Component.provide([RetryLoad.layer]));
