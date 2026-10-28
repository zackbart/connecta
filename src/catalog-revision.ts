// Only counters cross request boundaries. No catalogs, identities or secrets
// are retained here; weak owners are the deployment's cache store and vault.
const revisions = new WeakMap<object, number>();

export function catalogRevision(owner: object | undefined): number {
  return owner ? (revisions.get(owner) ?? 0) : 0;
}

export function advanceCatalogRevision(owner: object): void {
  revisions.set(owner, catalogRevision(owner) + 1);
}
