// The production candidate is compiled unchanged; only the legacy baseline is
// substituted. Keep its exact reviewed dispatcher independent of future edits.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const baseline = new URL("../../test/fixtures/effect-proof/legacy-server.ts.txt", import.meta.url);
export const baselineCommit = "ac511e6b033511229540481e70d33f6f14a7dc84";
const baselineHash = "50f75123588f63665a2b1a1dcf05a1775ef61c0a103ac657b780b1bc59b3fea1";
const marker = "CONNECTA_PROOF_ROUTER_TRANSFORM";

export function candidateSource(source) {
  if (
    !source.includes('import { createRouteDispatcher } from "./routes/dispatch.js";') ||
    !source.includes("const route = createRouteDispatcher(routeMcp.handle, metadata, health);") ||
    source.includes(marker)
  )
    throw new Error("Production router proof drift");
  return source + `\nexport const ${marker} = true;\n`;
}

export function baselineSource(source) {
  if (createHash("sha256").update(source).digest("hex") !== baselineHash)
    throw new Error("Frozen legacy dispatcher changed");
  return source;
}

export function routerCandidate({ legacy = false, filter = /\/src\/server\.ts$/, onApplied = () => {} } = {}) {
  let count = 0;
  return {
    name: legacy ? "proof-frozen-legacy" : "proof-production-router",
    setup(bundle) {
      bundle.onStart(() => {
        count = 0;
      });
      bundle.onLoad({ filter }, async ({ path }) => {
        count++;
        return {
          contents: legacy
            ? baselineSource(await readFile(baseline, "utf8"))
            : candidateSource(await readFile(path, "utf8")),
          loader: "ts",
        };
      });
      bundle.onEnd((result) => {
        if (result.errors.length) return;
        if (count !== 1) throw new Error(`Proof router transform count ${count}; expected exactly 1`);
        onApplied(count);
      });
    },
  };
}
