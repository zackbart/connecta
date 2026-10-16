import type { OperatorState } from "../view.js";
import { configSummary } from "../config-summary.js";
import { accessChips } from "../endpoints.js";
import { ContractState, maintainerContract } from "./contract-state.js";
import {
  DefaultLimits,
  FactChips,
  FeatureTiles,
  OverrideChips,
  SignInTiles,
  StatTiles,
  TileSection,
} from "./config-tiles.js";
import { Icon } from "./icons.js";

export function SettingsPage({ state }: { state: OperatorState }) {
  const contract = maintainerContract(state);
  const summary = contract?.config ? configSummary(contract.config, contract.configSources ?? {}) : null;
  return (
    <section id="settingsView">
      <div className="page-heading">
        <div className="settings-title">
          <h1 id="settingsHeading" tabIndex={-1}>
            Settings
          </h1>
          <span className="code-tag">
            <Icon name="lock" size={12} />
            Defined in code
          </span>
        </div>
      </div>
      {!summary || !contract?.root ? (
        <ContractState state={state} />
      ) : (
        <div className="settings-board">
          <TileSection id="deploymentHeading" title="Deployment">
            <FactChips facts={summary.deployment} />
          </TileSection>
          <TileSection id="signInHeading" title="Sign-in">
            <SignInTiles tiles={summary.signIn} maintainers={accessChips(contract.root.maintainers)} />
          </TileSection>
          <TileSection id="featuresHeading" title="Features">
            <FeatureTiles tiles={summary.features} />
          </TileSection>
          <TileSection id="limitsHeading" title="Limits">
            <StatTiles tiles={summary.limits} label="Limits" />
            <DefaultLimits groups={summary.defaults} />
          </TileSection>
          {summary.overrides.length ? (
            <TileSection id="overridesHeading" title="Overrides">
              <OverrideChips overrides={summary.overrides} />
            </TileSection>
          ) : null}
          {summary.other.length ? (
            <TileSection id="otherHeading" title="Other">
              <StatTiles tiles={summary.other} compact label="Other settings" />
            </TileSection>
          ) : null}
        </div>
      )}
    </section>
  );
}
