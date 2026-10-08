// GitHub downloads PKCS#1 PEMs. WebCrypto imports PKCS#8, so wrap the RSA
// sequence without interpreting or reserializing its private integers.
function sequence(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  let length = content.length;
  const octets: number[] = [];
  if (length < 128) octets.push(length);
  else {
    while (length) { octets.unshift(length & 255); length >>>= 8; }
    octets.unshift(128 | octets.length);
  }
  return new Uint8Array([tag, ...octets, ...content]);
}

function element(bytes: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if (tag === undefined || length === undefined) throw new Error("invalid DER");
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 4 || offset + count > bytes.length) throw new Error("invalid DER");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++]!;
  }
  if (offset + length > bytes.length) throw new Error("invalid DER");
  return { tag, start: offset, end: offset + length };
}

const ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

export function privateKeyDer(pem: string): Uint8Array<ArrayBuffer> {
  try {
    const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]+)\s*-----END \1-----$/.exec(pem.replace(/\\n/g, "\n").trim());
    if (!match) throw new Error("invalid PEM");
    const binary = atob(match[2]!.replace(/\s/g, ""));
    const der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const outer = element(der, 0);
    if (outer.tag !== 0x30 || outer.end !== der.length) throw new Error("invalid DER");
    const version = element(der, outer.start);
    if (version.tag !== 2 || version.end - version.start !== 1 || der[version.start] !== 0) throw new Error("invalid version");
    let rsa = der;
    if (match[1] === "PRIVATE KEY") {
      const algorithm = element(der, version.end);
      if (algorithm.end - version.end !== ALGORITHM.length ||
          !ALGORITHM.every((byte, i) => byte === der[version.end + i])) throw new Error("not RSA");
      const octet = element(der, algorithm.end);
      if (octet.tag !== 4 || octet.end !== outer.end) throw new Error("invalid PKCS8");
      rsa = der.slice(octet.start, octet.end);
    }
    const root = element(rsa, 0);
    let offset = root.start;
    const integers = [];
    while (offset < root.end) {
      const integer = element(rsa, offset);
      if (integer.tag !== 2 || integer.end <= integer.start || integer.end > root.end) throw new Error("invalid RSA");
      integers.push(integer); offset = integer.end;
    }
    if (root.tag !== 0x30 || root.end !== rsa.length || integers.length !== 9 ||
        rsa[integers[0]!.start] !== 0) throw new Error("invalid RSA");
    const modulus = integers[1]!;
    const first = modulus.start + (rsa[modulus.start] === 0 ? 1 : 0);
    const bits = (modulus.end - first - 1) * 8 + 32 - Math.clz32(rsa[first]!);
    if (bits < 2048) throw new Error("weak RSA");
    if (match[1] === "PRIVATE KEY") return der;
    return sequence(0x30, new Uint8Array([2, 1, 0, ...ALGORITHM, ...sequence(4, rsa)]));
  } catch {
    throw new Error("app.privateKey to be a complete PKCS#1 or PKCS#8 RSA PEM with at least 2048 bits.");
  }
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function appJwt(appId: string, der: Uint8Array<ArrayBuffer>, now: number): Promise<string> {
  const encoder = new TextEncoder();
  const seconds = Math.floor(now / 1000);
  const data = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId })))}`;
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(data))))}`;
}
