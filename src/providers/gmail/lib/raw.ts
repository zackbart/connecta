import { decodeBase64url } from "../../../bytes.js";
import { carriesWithheldLink } from "../../_shared/rest/value-safety.js";

/**
 * Gmail decodes a message's `raw` field itself (base64url RFC 2822), so the
 * hatch's ordinary admission sees only its encoding. Decode the documented
 * field once, bounded by its own length, and refuse a withheld destination
 * before anything is sent. Messages, imports and inserts carry `raw` at the
 * top; drafts nest it under `message`.
 */
export function refuseWithheldRaw(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const message = record["message"];
  const lanes = [
    record["raw"],
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)["raw"]
      : undefined,
  ];
  for (const raw of lanes) {
    if (raw === undefined) continue;
    if (typeof raw !== "string") return "Gmail raw must be a base64url string of an RFC 2822 message.";
    let text: string;
    try {
      text = new TextDecoder().decode(decodeBase64url(raw, true));
    } catch {
      return "Gmail raw must be valid base64url of an RFC 2822 message.";
    }
    if (carriesWithheldLink(text))
      return "Not sent: this raw message carries a URL whose query or fragment Connecta withheld ([redacted]). Supply the original link or omit it.";
  }
  return undefined;
}
