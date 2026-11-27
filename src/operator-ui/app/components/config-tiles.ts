import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import type {
  ConnectorBadge,
  DefaultGroup,
  FactChip,
  FeatureTile,
  OverrideChip,
  SignInTile,
  StatTile,
} from "../../config-summary.js";
import type { AccessChip } from "../../endpoints.js";
import { Icon } from "./icons.js";

export const TileSection = <M, C extends View.Children<M>>(
  h: Html.H<M>,
  options: { readonly id: string; readonly title: string; readonly children: C },
) =>
  h.section
    .class("tile-section")
    .attr("aria-labelledby", options.id)
    .children(h.h2.attr("id", options.id).class("tile-section-title").children(options.title), options.children);

export const StatTiles = <M>(
  h: Html.H<M>,
  options: { readonly tiles: ReadonlyArray<StatTile>; readonly label: string; readonly compact?: boolean },
) =>
  options.tiles.length
    ? h.dl
        .class("stat-grid", options.compact && "compact")
        .attr("aria-label", options.label)
        .children(
          options.tiles.map((tile) =>
            h.div
              .key(tile.id)
              .class("stat-tile", tile.set && "set")
              .attr("data-config-path", tile.id)
              .children(
                h.dt.children(tile.label),
                h.dd.children(
                  h.span.class("stat-value").attr("title", tile.title).children(tile.value),
                  tile.set
                    ? h.span
                        .class("set-dot")
                        .attr("title", "Set in code")
                        .children(h.span.class("visually-hidden").children(", set in code"))
                    : h.span.class("visually-hidden").children(", default"),
                ),
              ),
          ),
        )
    : null;

export const DefaultLimits = <M>(h: Html.H<M>, groups: ReadonlyArray<DefaultGroup>) => {
  const count = groups.reduce((total, group) => total + group.tiles.length, 0);
  if (!count) return null;
  return h.details.class("defaults").children(
    h.summary.children(Icon(h, "chevron", 14), `${count} ${count === 1 ? "default" : "defaults"}`),
    h.div.class("default-groups").children(
      groups.map((group) =>
        h.section
          .key(group.id)
          .class("default-group")
          .attr("aria-labelledby", `defaults-${group.id}`)
          .children(
            h.h3.attr("id", `defaults-${group.id}`).children(group.title),
            h.dl.children(
              group.tiles.map((tile) =>
                h.div
                  .key(tile.id)
                  .attr("data-config-path", tile.id)
                  .children(
                    h.dt.children(tile.label),
                    h.dd
                      .attr("title", tile.title)
                      .children(tile.value, h.span.class("visually-hidden").children(", default")),
                  ),
              ),
            ),
          ),
      ),
    ),
  );
};

export const FeatureTiles = <M>(h: Html.H<M>, tiles: ReadonlyArray<FeatureTile>) =>
  h.ul
    .class("feature-grid")
    .attr("aria-label", "Features")
    .children(
      tiles.map((tile) =>
        h.li
          .key(tile.id)
          .class("feature-tile", tile.on && "on")
          .attr("data-feature", tile.id)
          .children(
            h.span.class("feature-icon").children(Icon(h, tile.icon, 18)),
            h.span.class("feature-name").children(tile.label),
            tile.detail ? h.span.class("feature-detail").children(Icon(h, "check", 11), tile.detail) : null,
            h.span
              .class("feature-state")
              .children(
                Icon(h, tile.on ? "check" : "minus", 14),
                h.span.class("visually-hidden").children(tile.on ? "On" : "Off"),
              ),
          ),
      ),
    );

const ClerkGlyph = <M>(h: Html.H<M>) =>
  h
    .el("svg")
    .attrs({ viewBox: "0 0 24 24", width: "20", height: "20", fill: "none", focusable: "false" })
    .children(
      h.el("path").attrs({
        d: "M17.5 6.6a8 8 0 1 0 0 10.8",
        stroke: "currentColor",
        "stroke-width": "2.6",
        "stroke-linecap": "round",
      }),
      h.el("circle").attrs({ cx: "12", cy: "12", r: "3", fill: "currentColor" }),
    );

const ProviderMark = <M>(h: Html.H<M>, mark: SignInTile["mark"]) =>
  h.span
    .class("provider-mark", mark)
    .attr("aria-hidden", "true")
    .children(
      mark === "clerk"
        ? ClerkGlyph(h)
        : Icon(h, mark === "access" ? "cloud" : mark === "tokens" ? "key" : "shield", 18),
    );

const AvatarStack = <M>(h: Html.H<M>, chips: ReadonlyArray<AccessChip>, label: string) => {
  const shown = chips.slice(0, 5);
  const more = chips.length - shown.length;
  return h.ul
    .class("avatar-stack")
    .attr("aria-label", label)
    .children(
      shown.map((chip) =>
        h.li
          .key(chip.key)
          .attr("title", chip.text)
          .children(
            chip.kind === "agent"
              ? h.span
                  .class("avatar", "agent")
                  .attr("aria-hidden", "true")
                  .children(Icon(h, "key", 12))
              : h.span.class("avatar", `hue-${chip.hue}`).attr("aria-hidden", "true").children(chip.initials),
            h.span.class("visually-hidden").children(chip.text),
          ),
      ),
      more > 0
        ? h.li
            .key("more")
            .class("avatar-more")
            .children(
              h.span.attr("aria-hidden", "true").children(`+${more}`),
              h.span.class("visually-hidden").children(`and ${more} more`),
            )
        : null,
    );
};

export const SignInTiles = <M>(
  h: Html.H<M>,
  tiles: ReadonlyArray<SignInTile>,
  maintainers: ReadonlyArray<AccessChip>,
) =>
  h.ul.class("identity-grid").children(
    !tiles.length
      ? h.li
          .key("open")
          .class("identity-tile", "open")
          .children(
            h.span
              .class("provider-mark", "other")
              .attr("aria-hidden", "true")
              .children(Icon(h, "alert", 18)),
            h.span.class("identity-name").children("Open"),
            h.span.class("identity-kind").children("No sign-in"),
          )
      : null,
    tiles.map((tile) =>
      h.li
        .key(tile.id)
        .class("identity-tile")
        .attr("data-sign-in", tile.id)
        .children(
          ProviderMark(h, tile.mark),
          h.span.class("identity-name").children(tile.label),
          h.span
            .class("identity-kind")
            .children(Icon(h, tile.interactive ? "users" : "key", 13), tile.interactive ? "People" : "Machines"),
          tile.count ? h.span.class("count-chip").children(tile.count) : null,
        ),
    ),
    h.li
      .key("maintainers")
      .class("identity-tile", "maintainers")
      .attr("data-sign-in", "maintainers")
      .children(
        h.span
          .class("provider-mark", "other")
          .attr("aria-hidden", "true")
          .children(Icon(h, "users", 18)),
        h.span.class("identity-name").children("Maintainers"),
        h.span.class("identity-kind", "mono").children("/mcp"),
        maintainers.length ? AvatarStack(h, maintainers, "Maintainers") : h.span.class("count-chip").children("None"),
      ),
  );

export const FactChips = <M>(h: Html.H<M>, facts: ReadonlyArray<FactChip>) =>
  h.dl
    .class("fact-chips")
    .attr("aria-label", "Deployment")
    .children(
      facts.map((fact) =>
        h.div
          .key(fact.id)
          .class("fact-chip", fact.tone)
          .attr("data-fact", fact.id)
          .attr("title", fact.title)
          .children(
            h.dt.children(fact.tone === "warn" ? Icon(h, "alert", 12) : null, fact.label),
            h.dd.class(fact.mono && "mono").children(fact.value),
          ),
      ),
    );

export const OverrideChips = <M>(h: Html.H<M>, overrides: ReadonlyArray<OverrideChip>) =>
  h.ul
    .class("override-chips")
    .attr("aria-label", "Classification overrides")
    .children(
      overrides.map((override) =>
        h.li
          .key(override.address)
          .class("override-chip")
          .children(
            h.code.children(override.address),
            h.span
              .class("override-verdict", override.classification)
              .children(h.span.class("visually-hidden").children("classified as "), override.classification),
          ),
      ),
    );

export const BadgeRow = <M>(h: Html.H<M>, badges: ReadonlyArray<ConnectorBadge>, label: string) =>
  h.ul
    .class("config-badges")
    .attr("aria-label", label)
    .children(
      badges.map((badge) =>
        h.li
          .key(badge.id)
          .class("config-badge", badge.mono && "mono")
          .attr("data-badge", badge.id)
          .attr("title", badge.title)
          .children(
            badge.icon ? Icon(h, badge.icon, 13) : null,
            badge.prefix ? h.span.class("badge-prefix").children(badge.prefix) : null,
            badge.label,
          ),
      ),
    );
