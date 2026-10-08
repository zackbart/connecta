import type { ActivityRequestContext } from "./activity.js";

// Weak ownership keeps the grouping context within the request's lifetime.
const requests = new WeakMap<object, ActivityRequestContext>();
export function bindActivityRequest(scope: object, context: ActivityRequestContext): void {
  requests.set(scope, context);
}
export function activityRequest(scope: object | undefined): ActivityRequestContext | undefined {
  return scope ? requests.get(scope) : undefined;
}
