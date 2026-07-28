const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Fail loudly when JavaScript callers pass the retired audience-scoping keys. */
export function assertNoRetiredToolkitOptions(
  source: string,
  options: object,
): void {
  if (!hasOwn(options, "toolkits") && !hasOwn(options, "unscoped")) return;
  throw new Error(
    `${source} options \`toolkits\` and \`unscoped\` were removed in issue ` +
      "#178. Deploy one connecta instance per audience instead; see ethos.md.",
  );
}
