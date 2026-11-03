/**
 * The fixed sentence that marks downstream guidance as third-party. A prefix has
 * no closing delimiter to forge, and connector IDs are deployment-authored.
 */
export function downstreamOrigin(connectorId: string): string {
  return `Third-party guidance from connector ${JSON.stringify(connectorId.slice(0, 128))}.`;
}

/** Downstream description text on one line, so it cannot begin a new listing entry. */
export function labeledDownstreamDescription(connectorId: string, description: string): string {
  return `${downstreamOrigin(connectorId)} ${description.replace(/\s+/g, " ").trim()}`;
}

const SKILL_RESOURCE = /^skill:\/\/|\/SKILL\.md(?:[?#]|$)/i;

/** Whether a downstream resource URI addresses skill instructions rather than ordinary data. */
export function isSkillResource(uri: string): boolean {
  return SKILL_RESOURCE.test(uri);
}
