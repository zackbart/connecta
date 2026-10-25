import { queueFetch, runAgentNamespaces, runDispatchLatency, runLifetimes, runMcp, runRouterSeam, runRouterIsolation, runRoutingEdges, runRoutes, transformed } from "./observations.js";

export default {
  async fetch(request: Request) {
    switch (new URL(request.url).pathname) {
      case "/proof/edges": return Response.json(await runRoutingEdges());
      case "/proof/routes": return Response.json(await runRoutes());
      case "/proof/transform": return Response.json({ applied: transformed() });
      case "/proof/latency": return Response.json(await runDispatchLatency());
      case "/proof/mcp": return Response.json(await runMcp(await request.json() as Array<Record<string, unknown>>));
      case "/proof/isolation": return Response.json(await runRouterIsolation());
      case "/proof/seam": return Response.json(await runRouterSeam());
      case "/proof/agents": return Response.json(await runAgentNamespaces());
      case "/proof/lifetimes": return Response.json(await runLifetimes());
      default: return queueFetch(request);
    }
  },
};
