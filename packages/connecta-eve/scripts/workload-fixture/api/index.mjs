import { waitUntil } from "@vercel/functions";
import { getVercelOidcToken, exchangeVercelOidcToken } from "@vercel/oidc";
import { handle } from "../handler.mjs";

export async function POST(request) {
  return handle(request, {
    origin: `https://${process.env.VERCEL_URL}`,
    expected: {
      team: process.env.PROOF_TEAM_ID,
      project: process.env.PROOF_PROJECT_ID,
      owner: process.env.PROOF_OWNER_SLUG,
      projectName: process.env.PROOF_PROJECT_NAME,
    },
    runId: process.env.PROOF_RUN_ID,
    runKey: process.env.PROOF_RUN_KEY,
    bypass: process.env.PROOF_BYPASS_KEY,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
    getToken: getVercelOidcToken,
    exchange: exchangeVercelOidcToken,
    retain: waitUntil,
    emit: (receipt) => console.info(JSON.stringify(receipt)),
  });
}
