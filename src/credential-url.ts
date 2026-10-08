import { ConnectorCallError } from "./errors.js";

function refused(): never {
  throw new ConnectorCallError("connector_call_failed",
    "OAuth metadata or consent URL cannot be safely checked; refusing authorization.", { retryable: false });
}

/** Matching only: never change the endpoint that discovery supplied. */
function percentDecoded(value: string): string {
  for (let pass = 0; pass < 8; pass++) {
    const next = value.replace(/(?:%[0-9a-f]{2})+/gi, (escaped) => {
      try { return decodeURIComponent(escaped); }
      catch {
        // Malformed UTF-8 must not hide adjacent valid ASCII escapes.
        return escaped.replace(/%([0-7][0-9a-f])/gi, (_, byte: string) => String.fromCharCode(parseInt(byte, 16)));
      }
    });
    if (next === value) return value;
    value = next;
  }
  // Deeper nesting has no stable matching view within the normalization bound.
  if (/%[0-9a-f]{2}/i.test(value)) refused();
  return value;
}

/** RFC 3492 decoding, using no Node-only URL or punycode implementation. URL
 * has already validated the ASCII host. Bound arithmetic and Unicode scalars. */
function unicodeLabel(label: string): string {
  if (!label.startsWith("xn--")) return label;
  const input = label.slice(4);
  const delimiter = input.lastIndexOf("-");
  const output = delimiter < 0 ? [] : Array.from(input.slice(0, delimiter), (char) => char.charCodeAt(0));
  let cursor = delimiter < 0 ? 0 : delimiter + 1;
  let n = 128;
  let i = 0;
  let bias = 72;
  while (cursor < input.length) {
    const previous = i;
    let weight = 1;
    for (let k = 36; ; k += 36) {
      const code = input.charCodeAt(cursor++);
      const digit = code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? code - 22 : 36;
      if (digit >= 36) refused();
      i += digit * weight;
      if (!Number.isSafeInteger(i)) refused();
      const threshold = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < threshold) break;
      weight *= 36 - threshold;
      if (!Number.isSafeInteger(weight)) refused();
    }
    const count = output.length + 1;
    let delta = previous === 0 ? Math.floor((i - previous) / 700) : Math.floor((i - previous) / 2);
    delta += Math.floor(delta / count);
    let k = 0;
    while (delta > 455) { delta = Math.floor(delta / 35); k += 36; }
    bias = k + Math.floor(36 * delta / (delta + 38));
    n += Math.floor(i / count);
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) refused();
    i %= count;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** Decode each component, and concatenate with and without query names so a
 * credential split across path/query boundaries still matches. Hosts have
 * ASCII and Unicode views and match case-insensitively; paths remain exact. */
export function credentialUrlViews(value: string): { hosts: string[]; components: string[]; joined: string[] } {
  let url: URL;
  try { url = new URL(value); } catch { return refused(); }
  const host = url.hostname.toLowerCase();
  const hosts = [host, host.split(".").map(unicodeLabel).join(".").toLowerCase()];
  const path = url.pathname.split("/").map(percentDecoded);
  const query = [...url.searchParams].map(([key, item]) => [percentDecoded(key), percentDecoded(item)]);
  const prefix = [url.protocol, percentDecoded(url.username), percentDecoded(url.password)];
  const suffix = [percentDecoded(url.hash.slice(1))];
  const components = [value, percentDecoded(url.href), ...prefix, ...hosts, url.port,
    percentDecoded(url.pathname), percentDecoded(url.search), ...path, ...query.flat(), ...suffix];
  const joined = hosts.flatMap((hostname) => [
    [...prefix, hostname, url.port, ...path, ...query.flat(), ...suffix].join(""),
    [...prefix, hostname, url.port, ...path, ...query.map((entry) => entry[1]), ...suffix].join(""),
  ]);
  return { hosts, components, joined };
}
