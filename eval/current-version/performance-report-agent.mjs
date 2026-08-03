function point(value) {
  return {
    min: value,
    p50: value,
    p95: value,
    max: value,
    mean: value,
    stddev: 0,
  };
}

function legacyRun(fixture, index) {
  const connectaRoundTrips = fixture.toolCalls?.length ?? 0;
  const costEfficient =
    fixture.routeEfficient === true &&
    fixture.contextEfficient === true;
  return {
    ...fixture,
    repetition: 1,
    taskCorrect: fixture.correct === true,
    safetyPassed: null,
    surfaceValid: null,
    costEfficient,
    connectaRoundTrips,
    outerTools: fixture.calledTools ?? [],
    costEnvelope: {
      maxRoundTrips: null,
      maxMcpResultTokens: fixture.mcpResultTokenBudget,
    },
    legacyIndex: index,
  };
}

function legacyCase(run) {
  return {
    id: run.id,
    repetitions: 1,
    rates: {
      taskCorrect: Number(run.taskCorrect),
      safetyPassed: null,
      surfaceValid: null,
      costEfficient: Number(run.costEfficient),
      passed: Number(run.passed === true),
    },
    observedRoutes: [{
      route: run.outerTools.join(" → ") || "(none)",
      count: 1,
    }],
    connectaRoundTrips: point(run.connectaRoundTrips),
    mcpResultTokens: point(run.mcpResultTokens),
    latencyMs: point(run.latencyMs),
    costEnvelope: run.costEnvelope,
    runs: [run],
  };
}

export function normalizeAgentBenchmark(agent) {
  if (agent.schemaVersion === 2 || agent.schemaVersion === 3) {
    return {
      ...agent,
      reportSchema: `v${agent.schemaVersion}`,
      summary: {
        ...agent.summary,
        runs: agent.summary.runs ?? agent.runs.length,
      },
    };
  }
  if (agent.schemaVersion !== 1) {
    throw new Error(
      `Unsupported agent benchmark schema ${String(agent.schemaVersion)}.`,
    );
  }
  const runs = agent.cases.map(legacyRun);
  return {
    ...agent,
    reportSchema: "v1-legacy",
    runs,
    cases: runs.map(legacyCase),
    summary: {
      ...agent.summary,
      runs: runs.length,
      costEfficient: runs.filter((run) => run.costEfficient).length,
      safetyPassed: null,
      surfaceValid: null,
    },
  };
}
