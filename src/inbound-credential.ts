/** Reserved machine syntax, even when the optional verifier is not installed. */
export function isMachineCredential(request: Request): boolean {
  return /^Bearer\s+cta_/iu.test(request.headers.get("authorization") ?? "");
}
