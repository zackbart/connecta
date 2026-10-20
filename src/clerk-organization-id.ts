/**
 * Clerk's organization ID grammar from its Backend API contract. `clerkAuth`
 * checks `organizationId` with it at construction, and pages check
 * `UiAuthConfig.organizationId` with it before it reaches inline config.
 */
export function isClerkOrganizationId(value: unknown): value is string {
  return typeof value === "string" && /^org_[A-Za-z0-9_]{27}$/.test(value);
}
