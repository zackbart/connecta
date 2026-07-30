function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function integer(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function renderReport(audit, jsonName) {
  const categoryRows = Object.entries(audit.discovery.categories)
    .map(
      ([name, metrics]) =>
        `| ${name} | ${metrics.queries} | ${
          metrics.top1Accuracy === null ? "—" : pct(metrics.top1Accuracy)
        } | ${
          metrics.positiveRecall === null ? "—" : pct(metrics.positiveRecall)
        } | ${metrics.meanPrecision.toFixed(3)} | ${
          metrics.falsePositiveRate === null
            ? "—"
            : pct(metrics.falsePositiveRate)
        } | ${metrics.meanResultCount.toFixed(2)} | ${metrics.meanResponseTokens.toFixed(1)} |`,
    )
    .join("\n");
  const failed = audit.tasks.cases.filter((entry) => !entry.passed);

  return `# Current-version Connecta audit

Source commit: \`${audit.source.commit}\`

Runtime: Node ${audit.source.nodeVersion}; tokenizer \`${audit.source.tokenizer}\`; surface \`${audit.source.surface}\`; executor \`${audit.source.executorMode}\`

Machine-readable results: [\`${jsonName}\`](./${jsonName})

## Qualification

- Release gate: ${audit.qualification.passed ? "pass" : "FAIL"}
- Task scenarios: ${audit.tasks.summary.passed}/${audit.tasks.summary.caseCount} passed (${pct(audit.tasks.summary.taskSuccessRate)})
- Discovery top-1 accuracy: ${pct(audit.discovery.metrics.top1Accuracy)}
- Discovery positive recall: ${pct(audit.discovery.metrics.positiveRecall)}
- Recall at the default page: ${pct(audit.discovery.metrics.recallAtDefaultPage)}
- Negative-query false-positive rate: ${pct(audit.discovery.metrics.falsePositiveRate)}
- Round trips: ${audit.totals.roundTrips}; summed call latency: ${audit.totals.summedLatencyMs.toFixed(1)} ms
- Connecta surface: ${integer(audit.totals.definitionTokens)} definition + ${integer(audit.totals.requestTokens)} request + ${integer(audit.totals.responseTokens)} response = **${integer(audit.totals.measuredSurfaceTokens)} tokens**
- Result compatibility observed: \`content\` ${audit.compatibility.contentResults}/${audit.compatibility.resultCount}, \`structuredContent\` ${audit.compatibility.structuredContentResults}/${audit.compatibility.resultCount}
- \`execute_code\` advertised: ${audit.compatibility.executeCodeAdvertised ? "yes" : "no"}
- Payload-free activity invariant: ${audit.invariants.activityPayloadFree ? "pass" : "FAIL"}

${failed.length === 0 ? "" : `Failed task scenarios: ${failed.map((entry) => `\`${entry.name}\``).join(", ")}\n`}
## Discovery holdout

The holdout contains ${audit.discovery.corpus.toolCount} tools across ${audit.discovery.corpus.connectorCount} connectors and ${audit.discovery.corpus.queryCount} independently authored queries. It is release qualification evidence and must not be used to tune ranking behavior.

| Category | Queries | Top-1 | Recall | Precision | False positives | Mean results | Mean response tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${categoryRows}

## Scope

The audit exercises discovery, description, direct calls, batching, code-mode reduction, truncation and paging, destructive approval routing, OAuth recovery, static-credential operator recovery, unavailable recovery, and activity shape. Token counts cover the JSON-serialized MCP tool definitions, requests, and complete results observed by the SDK client; model deliberation and host-specific envelopes are outside this measurement.
`;
}
