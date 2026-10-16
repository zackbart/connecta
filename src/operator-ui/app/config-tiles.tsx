import type { ReactNode } from "react";
import type { ConnectorBadge, FactChip, FeatureTile, OverrideChip, SignInTile, StatTile } from "../config-summary.js";
import type { AccessChip } from "../endpoints.js";
import { Icon } from "./icons.js";

/**
 * The configuration readout's pieces: tiles, chips and marks, no prose. Each
 * list is semantic (a `dl` of label and value, or a `ul`), and every state a
 * color shows is also a shape and a hidden word.
 */

/** A short heading over one group of tiles; the group's own markup follows. */
export function TileSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="tile-section" aria-labelledby={id}>
      <h2 id={id} className="tile-section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Big value, tiny label. A value set in code gets an accent dot; a default reads muted. */
export function StatTiles({ tiles, compact, label }: { tiles: StatTile[]; compact?: boolean; label: string }) {
  if (!tiles.length) return null;
  return (
    <dl className={compact ? "stat-grid compact" : "stat-grid"} aria-label={label}>
      {tiles.map((tile) => (
        <div key={tile.id} className={tile.set ? "stat-tile set" : "stat-tile"} data-config-path={tile.id}>
          <dt>{tile.label}</dt>
          <dd>
            <span className="stat-value">{tile.value}</span>
            {tile.set ? (
              <span className="set-dot" title="Set in code">
                <span className="visually-hidden">, set in code</span>
              </span>
            ) : (
              <span className="visually-hidden">, default</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** An optional module: its icon filled when on, greyed when off, with a check or a dash. */
export function FeatureTiles({ tiles }: { tiles: FeatureTile[] }) {
  return (
    <ul className="feature-grid" aria-label="Features">
      {tiles.map((tile) => (
        <li key={tile.id} className={tile.on ? "feature-tile on" : "feature-tile"} data-feature={tile.id}>
          <span className="feature-icon">
            <Icon name={tile.icon} size={18} />
          </span>
          <span className="feature-name">{tile.label}</span>
          <span className="feature-state">
            <Icon name={tile.on ? "check" : "minus"} size={14} />
            <span className="visually-hidden">{tile.on ? "On" : "Off"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A sign-in provider's mark: a colored square with its glyph. */
function ProviderMark({ mark }: { mark: SignInTile["mark"] }) {
  return (
    <span className={`provider-mark ${mark}`} aria-hidden="true">
      {mark === "clerk" ? (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" focusable="false">
          <path d="M17.5 6.6a8 8 0 1 0 0 10.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
        </svg>
      ) : (
        <Icon name={mark === "access" ? "cloud" : mark === "tokens" ? "key" : "shield"} size={18} />
      )}
    </span>
  );
}

/** Up to five overlapping avatars, then "+N". Each name is in the list for a screen reader. */
function AvatarStack({ chips, label }: { chips: AccessChip[]; label: string }) {
  const shown = chips.slice(0, 5);
  const more = chips.length - shown.length;
  return (
    <ul className="avatar-stack" aria-label={label}>
      {shown.map((chip) => (
        <li key={chip.key} title={chip.text}>
          {chip.kind === "agent" ? (
            <span className="avatar agent" aria-hidden="true">
              <Icon name="key" size={12} />
            </span>
          ) : (
            <span className={`avatar hue-${chip.hue}`} aria-hidden="true">
              {chip.initials}
            </span>
          )}
          <span className="visually-hidden">{chip.text}</span>
        </li>
      ))}
      {more > 0 ? (
        <li className="avatar-more">
          <span aria-hidden="true">+{more}</span>
          <span className="visually-hidden">and {more} more</span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Each sign-in method: its mark, its name, who it admits, and the people (or
 * agents) behind it. An open deployment draws one tile that says so.
 */
export function SignInTiles({
  tiles,
  maintainers,
  agents,
}: {
  tiles: SignInTile[];
  maintainers: AccessChip[];
  agents: AccessChip[];
}) {
  if (!tiles.length)
    return (
      <ul className="identity-grid">
        <li className="identity-tile open">
          <span className="provider-mark other" aria-hidden="true">
            <Icon name="alert" size={18} />
          </span>
          <span className="identity-name">Open</span>
          <span className="identity-kind">No sign-in</span>
        </li>
      </ul>
    );
  return (
    <ul className="identity-grid">
      {tiles.map((tile) => {
        const people = tile.interactive ? maintainers : tile.mark === "tokens" ? agents : [];
        return (
          <li key={tile.id} className="identity-tile" data-sign-in={tile.id}>
            <ProviderMark mark={tile.mark} />
            <span className="identity-name">{tile.label}</span>
            <span className="identity-kind">
              <Icon name={tile.interactive ? "users" : "key"} size={13} />
              {tile.interactive ? "People" : "Machines"}
            </span>
            {people.length ? (
              <AvatarStack
                chips={people}
                label={tile.mark === "tokens" && !tile.interactive ? "Agents" : "Maintainers"}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Deployment facts in one wrapping row of label and value chips. */
export function FactChips({ facts, brand }: { facts: FactChip[]; brand?: string }) {
  return (
    <dl className="fact-chips" aria-label="Deployment">
      {brand ? (
        <div className="fact-chip brand">
          <dt className="visually-hidden">Brand</dt>
          <dd>
            <span className="brand-swatch" aria-hidden="true" />
            {brand}
          </dd>
        </div>
      ) : null}
      {facts.map((fact) => (
        <div key={fact.id} className="fact-chip">
          <dt>{fact.label}</dt>
          <dd className={fact.mono ? "mono" : undefined}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What a connector is, in a row of badges. */
export function BadgeRow({ badges, label }: { badges: ConnectorBadge[]; label: string }) {
  return (
    <ul className="config-badges" aria-label={label}>
      {badges.map((badge) => (
        <li key={badge.id} className={badge.mono ? "config-badge mono" : "config-badge"} data-badge={badge.id}>
          {badge.icon ? <Icon name={badge.icon} size={13} /> : null}
          {badge.label}
        </li>
      ))}
    </ul>
  );
}

/** Classification overrides: each tool and the verdict code gives it. */
export function OverrideChips({ overrides }: { overrides: OverrideChip[] }) {
  return (
    <ul className="override-chips" aria-label="Classification overrides">
      {overrides.map((override) => (
        <li key={override.address} className="override-chip">
          <code>{override.address}</code>
          <span className={`override-verdict ${override.classification}`}>
            <span className="visually-hidden">classified as </span>
            {override.classification}
          </span>
        </li>
      ))}
    </ul>
  );
}
