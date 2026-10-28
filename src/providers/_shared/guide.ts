export function readOnlyNotice(readOnly: boolean | undefined): string[] {
  return readOnly ? ["This connection is read-only: every write is refused."] : [];
}
