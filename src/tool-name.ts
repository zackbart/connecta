/** C0, DEL, and C1 cannot occur in a callable downstream tool name. */
export function hasControlCharacters(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
