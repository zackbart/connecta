type AuthorizationCredential =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "bearer"; token: string; value: string };

const parsed = new WeakMap<Request, { header: string | null; credential: AuthorizationCredential }>();

/** One strict parse shared by recognition and verification. Schemes ignore case. */
export function authorizationCredential(request: Request): AuthorizationCredential {
  const header = request.headers.get("authorization");
  const cached = parsed.get(request);
  if (cached?.header === header) return cached.credential;
  // Exactly one separator and one token68 value. Reject combined duplicate
  // headers and malformed spacing rather than letting an SDK repair them.
  const match = header === null ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
  const credential: AuthorizationCredential = header === null ? { kind: "absent" }
    : match ? { kind: "bearer", token: match[1]!, value: `Bearer ${match[1]!}` }
    : { kind: "invalid" };
  parsed.set(request, { header, credential });
  return credential;
}

/** Explicit headers exclude cookies and Clerk's browser handshake credentials. */
export function authorizationRequest(request: Request): Request {
  const credential = authorizationCredential(request);
  if (credential.kind === "absent") return request;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  if (credential.kind === "bearer") headers.set("authorization", credential.value);
  const url = new URL(request.url);
  for (const key of new Set(url.searchParams.keys())) {
    if (key.startsWith("__clerk") || key === "__session" || key === "__dev_session") url.searchParams.delete(key);
  }
  if (url.href === request.url && !request.headers.has("cookie") && headers.get("authorization") === request.headers.get("authorization")) return request;
  // Share the body without cloning/teeing or transferring the original
  // request: the route must still be able to read it after authentication.
  const normalized = new Request(url, {
    method: request.method, headers, signal: request.signal,
    ...(request.body ? { body: request.body, duplex: "half" } : {}),
  });
  parsed.set(normalized, { header: headers.get("authorization"), credential });
  return normalized;
}

/** Reserved machine syntax, even when the optional verifier is not installed. */
export function isMachineCredential(request: Request): boolean {
  const credential = authorizationCredential(request);
  return credential.kind === "bearer" && credential.token.startsWith("cta_");
}
