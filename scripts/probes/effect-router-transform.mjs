import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const router = fileURLToPath(new URL("../../test/fixtures/effect-proof/router.ts", import.meta.url));
const marker = "CONNECTA_PROOF_ROUTER_TRANSFORM";

/** Change only compiled proof graphs. Fail on duplicate/structural transforms. */
export function candidateSource(source) {
  const start = source.indexOf("  const route = (context: RouteContext)");
  const end = source.indexOf("  const serve = (", start);
  if (start < 0 || end < 0 || source.includes(marker)) throw new Error("Proof route transform drift");
  return (
    `import { routeWithHttpRouter } from ${JSON.stringify(router)};\nexport const ${marker} = true;\n` +
    source.slice(0, start) +
    "  const route = (context: RouteContext) => routeWithHttpRouter(context, routeMcp.handle, metadata, health);\n\n" +
    source.slice(end)
  );
}

/** onEnd catches filter/rename misses, even when baseline compilation succeeds. */
export function routerCandidate({ filter = /\/src\/server\.ts$/, onApplied = () => {} } = {}) {
  let count = 0;
  return {
    name: "proof-router-candidate",
    setup(bundle) {
      bundle.onStart(() => {
        count = 0;
      });
      bundle.onLoad({ filter }, async ({ path }) => {
        const contents = candidateSource(await readFile(path, "utf8"));
        count++;
        return { contents, loader: "ts" };
      });
      bundle.onEnd((result) => {
        if (result.errors.length) return;
        if (count !== 1) throw new Error(`Proof router transform count ${count}; expected exactly 1`);
        onApplied(count);
      });
    },
  };
}

/** Runtime setup imports the marker, so a Vite filter miss cannot pass tests. */
export function vitestCandidate({ miss = false } = {}) {
  return {
    name: "effect-router-proof",
    enforce: "pre",
    transform(source, id) {
      if (!miss && id.replaceAll("\\", "/").split("?")[0].endsWith("/src/server.ts")) return candidateSource(source);
    },
  };
}
