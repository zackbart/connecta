import type { ConnectorContext } from "../types.js";

// Internal capability, deliberately absent from Connector's published surface.
// Hooks read only the context's owner partition and return no credential data.
type Observation = (context: ConnectorContext) => Promise<boolean>;
const observations = new WeakMap<object, Observation>();

export function withStoredAuth<T extends object>(target: T, observe: Observation): T {
  observations.set(target, observe);
  return target;
}

export function storedAuthObservation(target: object): Observation | undefined {
  return observations.get(target);
}
