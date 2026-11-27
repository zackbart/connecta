import { Predicate, Schema } from "effect";
import { shownHealth, type ConnectorHealth, type SteadyHealth } from "../../health.js";
import type { OperatorUiContractV2 } from "../../contract.js";
import type { ContractStateView } from "./contract-state.js";

export const opaque = <A>(name: string) =>
  Schema.declare<A>((input): input is A => Predicate.isObject(input), { identifier: name });

export const keepSame = <A extends Record<string, unknown>>() => {
  let last: A | null = null;
  return (next: A): A => {
    if (last && Object.keys(next).every((key) => Object.is(last![key], next[key]))) return last;
    last = next;
    return next;
  };
};

export const keepSameContractState = () => {
  let last: ContractStateView | null = null;
  return (next: ContractStateView): ContractStateView =>
    last && JSON.stringify(last) === JSON.stringify(next) ? last : (last = next);
};

export const keepShownHealth = () => {
  let last: { contract: OperatorUiContractV2 | null; steady: SteadyHealth; shown: ConnectorHealth } | null = null;
  return (contract: OperatorUiContractV2 | null, steady: SteadyHealth): ConnectorHealth => {
    if (last?.contract !== contract || last.steady !== steady)
      last = { contract, steady, shown: shownHealth(contract, steady) };
    return last.shown;
  };
};
