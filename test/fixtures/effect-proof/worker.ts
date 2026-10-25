import { queueFetch, runAgentNamespaces, runDispatchLatency, runLifetimes, runMcp, runRouterSeam, runRoutes, transformed } from "./observations.js";

export default {
  async fetch(request: Request) {
    switch (new URL(request.url).pathname) {
      case "/proof/routes": return Response.json(await runRoutes());
      case "/proof/transform": return Response.json({ applied: transformed() });
      case "/proof/latency": return Response.json(await runDispatchLatency());
      case "/proof/mcp": return Response.json(await runMcp(await request.json() as Array<Record<string, unknown>>));
      case "/proof/seam": return Response.json(await runRouterSeam());
      case "/proof/agents": return Response.json(await runAgentNamespaces());
      case "/proof/lifetimes": return Response.json(await runLifetimes());
      default: return queueFetch(request);
    }
  },
};
