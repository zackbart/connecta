import { ConnectorCallError } from "./errors.js";
import { percentDecoded } from "./credential-url.js";

/** Host-only MRTR material. This module must stay safe in executor bundles. */
export interface DownstreamInputResult {
  resultType: "input_required";
  inputRequests?: Record<string, unknown>;
  requestState?: string;
}

export function isDownstreamInputResult(value: unknown): value is DownstreamInputResult {
  return value !== null && typeof value === "object" && "resultType" in value && value.resultType === "input_required";
}

export interface InputContinuation {
  requestState?: string;
  inputResponses: Record<string, unknown>;
}
interface ContinuationTarget {
  connector: string;
  address: string;
  input: InputContinuation;
  privateStates: string[];
  write: boolean;
}
export interface InputCapabilities {
  elicitation?: { form?: Record<string, never>; url?: Record<string, never> };
}
const continuations = new WeakMap<object, ContinuationTarget>();
const capabilities = new WeakMap<object, InputCapabilities>();

export function bindDownstreamCapabilities(scope: object, declared: InputCapabilities): void {
  capabilities.set(scope, declared);
}

/** Only the relayable declarations travel to the downstream SDK, never grants. */
export function downstreamInputCapabilities(scope: object): InputCapabilities {
  return capabilities.get(scope) ?? {};
}

export function bindDownstreamContinuation(scope: object, target: ContinuationTarget): void {
  continuations.set(scope, target);
}

export function clearDownstreamContinuation(scope: object): void {
  continuations.delete(scope);
}

export function downstreamWriteContinuation(scope: object): boolean {
  return continuations.get(scope)?.write === true;
}

/** Check raw output before redaction, paging, caching, or shape observation. */
export function assertNoPrivateStateEchoes(value: unknown, states: string[]): void {
  const refused = () => new ConnectorCallError("input_required_invalid", "The downstream response exposes private continuation state.");
  try {
    // Literal matching avoids constructing a regex from a 64 KiB opaque value.
    // There is no credential length floor, and percent hex is case insensitive.
    const percent = (text: string) => text.replace(/%[0-9a-f]{2}/gi, hex => hex.toUpperCase());
    const forms = new Set<string>();
    for (const state of states) if (state) for (const framed of [state, `Bearer ${state}`, `token ${state}`]) {
      forms.add(percent(framed));
      try { forms.add(percent(encodeURIComponent(framed))); forms.add(percent(encodeURI(framed))); }
      catch { /* Lone surrogates still match literal and JSON-escaped views. */ }
      forms.add(percent(new URLSearchParams({ value: framed }).toString().slice(6)));
      let binary = "";
      for (const byte of new TextEncoder().encode(framed)) binary += String.fromCharCode(byte);
      const encoded = btoa(binary);
      forms.add(encoded);
      forms.add(encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    }
    if (!forms.size) return;
    const overlap = Math.max(...[...forms].map(form => form.length));
    const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    const matches = (text: string): boolean => {
      for (let pass = 0; pass < 3; pass++) {
        const unescaped = percentDecoded(text);
        const views = [percent(text), percent(unescaped)];
        if ([...forms].some(form => views.some(view => view.includes(form)))) return true;
        const decoded = unescaped.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g,
          escape => escape[1] === "u" ? String.fromCharCode(parseInt(escape.slice(2), 16)) : escapes[escape[1]!]!);
        if (decoded === text) break;
        text = decoded;
      }
      return false;
    };
    const binaryMatches = (encoded: string): boolean => {
      // MCP image/audio data and resource blobs are base64 bytes. Matching an
      // encoded state alone misses surrounding bytes at different alignments.
      // Decode fixed, four-character-aligned chunks and retain only overlap.
      const decoder = new TextDecoder();
      let utf8 = "", bytes = "";
      for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
        const chunk = atob(encoded.slice(offset, offset + 64 * 1024));
        const text = decoder.decode(Uint8Array.from(chunk, char => char.charCodeAt(0)), { stream: true });
        utf8 += text;
        bytes += chunk;
        if (matches(utf8) || matches(bytes)) return true;
        utf8 = utf8.slice(-overlap);
        bytes = bytes.slice(-overlap);
      }
      return matches(utf8 + decoder.decode());
    };
    const seen = new WeakSet<object>();
    const visit = (item: unknown): boolean => {
      if (typeof item === "string") return matches(item);
      if (item === null || typeof item === "boolean" || typeof item === "number") return matches(JSON.stringify(item));
      if (!item || typeof item !== "object" || seen.has(item)) return false;
      seen.add(item);
      if (item instanceof Error && matches(item.message)) return true;
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const type = descriptors.type?.value;
      const binary = type === "image" || type === "audio" ? descriptors.data?.value
        : typeof descriptors.uri?.value === "string" ? descriptors.blob?.value : undefined;
      if (typeof binary === "string" && binaryMatches(binary)) return true;
      const content = descriptors.content?.value;
      if (Array.isArray(content)) {
        const texts = content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text);
        if (matches(texts.join("")) || matches(texts.join("\n"))) return true;
      }
      return Object.entries(descriptors).some(([key, descriptor]) =>
        matches(key) || "value" in descriptor && visit(descriptor.value));
    };
    if (visit(value)) throw refused();
  } catch {
    // A privacy-check failure must never expose a matcher diagnostic or state.
    throw refused();
  }
}

export function assertDownstreamOutputSafe(scope: object, value: unknown): void {
  const continuation = continuations.get(scope);
  if (continuation) assertNoPrivateStateEchoes(value, continuation.privateStates);
}

/** The host binds one verified target before invocation constructs its context. */
export function downstreamContinuation(scope: object, connector: string, address: string): InputContinuation | undefined {
  const continuation = continuations.get(scope);
  if (!continuation) return undefined;
  if (continuation.connector !== connector || continuation.address !== address) {
    throw new ConnectorCallError("input_required_invalid", "The resolved target no longer matches this continuation.");
  }
  return continuation.input;
}
