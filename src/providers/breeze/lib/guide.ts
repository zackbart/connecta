export function usageGuide(
  subdomain: string,
  purpose: string,
  instructions: string | undefined,
  skill: { fragments: Readonly<Record<string, string>>; instructionsHeading: string },
): string {
  const churchInstructions = instructions?.trim();
  return `# Breeze ChMS usage

Church database for ${subdomain}${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${churchInstructions ? `\n## ${skill.instructionsHeading}\n\n${churchInstructions}\n` : ""}`;
}
