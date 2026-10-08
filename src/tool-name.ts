/** C0, DEL, and C1 cannot occur in a callable downstream tool name. */
export function hasControlCharacters(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Refuse static configuration before errors or warnings can render its names. */
export function assertStaticToolNames(tools: readonly { name: string }[], path: string): void {
  for (const [index, tool] of tools.entries()) {
    if (hasControlCharacters(tool.name)) {
      throw new Error(`${path}[${index}].name contains a control character.`);
    }
  }
}
