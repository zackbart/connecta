import { authCall, authFlow, authMethod } from "./native.js";
import { decodeJwt, jwksKeys, KEY_FETCH_BUSY, rs256Header, validJwtTime, verifyRs256 } from "./rs256-jwt.js";
// Built-in workload credentials: Web APIs only; no SDK or platform import.
import type { ResolvedAgent } from "../agent-config.js";
import { AGENT_NAMESPACE, agentSubjectId, trustAgentProvider } from "../agent-identity.js";
import { authenticationBusyResponse, withAuthenticationDeadline } from "../auth-admission.js";
import { authorizationCredential } from "../inbound-credential.js";
import type { AuthResult, InboundAuth, Logger } from "../types.js";

const ISSUER = "https://oidc.vercel.com";
const JWKS = `${ISSUER}/.well-known/jwks`;

function parsed(request: Request) {
  const credential = authorizationCredential(request);
  return credential.kind === "bearer" ? decodeJwt(credential.token) : undefined;
}

/** Recognition reserves Vercel's issuer namespace; verification still checks exact values. */
export function isVercelAgentCredential(request: Request): boolean {
  const iss = parsed(request)?.claims.iss;
  return typeof iss === "string" && (iss === ISSUER || iss.startsWith(`${ISSUER}/`));
}

function denied(): AuthResult {
  return {
    ok: false,
    response: Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
      },
    ),
  };
}

/** One bounded public-key cache per deployment; never retains request I/O or promises. */
export function vercelAgentAuth(agents: readonly ResolvedAgent[], logger: Logger = console): InboundAuth | undefined {
  const bindings = agents.filter((agent) => agent.vercel);
  if (bindings.length === 0) return undefined;
  const keys = jwksKeys(JWKS);

  return trustAgentProvider({
    kind: "vercel_oidc",
    activityActorNamespace: AGENT_NAMESPACE,
    recognizesCredential: isVercelAgentCredential,
    authorize: authMethod(function (request: Request) {
      return authFlow<AuthResult>(function* () {
        try {
          return (yield authCall(withAuthenticationDeadline, [
            request,
            authMethod((signal: AbortSignal) => {
              return authFlow<AuthResult>(function* () {
                const jwt = parsed(request);
                if (!jwt || !rs256Header(jwt.header)) return denied();
                const c = jwt.claims;
                const segment = (value: unknown, project: boolean = false): value is string =>
                  typeof value === "string" &&
                  (project ? /^[A-Za-z0-9._-]{1,128}(?![\s\S])/ : /^[A-Za-z0-9_-]{1,128}(?![\s\S])/).test(value);
                if (
                  !segment(c.owner) ||
                  !segment(c.project, true) ||
                  !segment(c.owner_id) ||
                  !segment(c.project_id) ||
                  !segment(c.environment) ||
                  c.external_sub !== undefined ||
                  (c.iss !== ISSUER && c.iss !== `${ISSUER}/${c.owner}`) ||
                  c.aud !== `https://vercel.com/${c.owner}` ||
                  c.sub !== `owner:${c.owner}:project:${c.project}:environment:${c.environment}`
                )
                  return denied();
                const agent = bindings.find(
                  ({ vercel: v }: ResolvedAgent) =>
                    v &&
                    v.team === c.owner_id &&
                    v.project === (v.project.startsWith("prj_") ? c.project_id : c.project) &&
                    v.environments.some((environment) => environment === c.environment),
                );
                if (!agent) return denied();
                if (!validJwtTime(c)) return denied();
                const key = (yield authCall(keys, [jwt.header.kid, signal])) as JsonWebKey | undefined;
                if (!key) return denied();
                const valid = (yield authCall(verifyRs256, [jwt, key, signal])) as boolean;
                if (!valid || !validJwtTime(c)) return denied();
                return { ok: true, agent: agent.name, subjectId: agentSubjectId(agent.name) };
              });
            }),
          ])) as AuthResult;
        } catch (error) {
          if (error === KEY_FETCH_BUSY)
            return {
              ok: false,
              response: authenticationBusyResponse(logger),
            };
          return denied();
        }
      });
    }),
  });
}
