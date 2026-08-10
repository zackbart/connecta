import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { round, structured } from "./audit-lib.mjs";

function addressesFrom(value) {
  return Array.isArray(value?.connectors)
    ? value.connectors.flatMap((group) =>
        Array.isArray(group.tools)
          ? group.tools.map((tool) => tool.address)
          : [],
      )
    : [];
}

function mean(items, select) {
  return items.length === 0
    ? 0
    : items.reduce((sum, item) => sum + select(item), 0) / items.length;
}

function withoutQueryCoverage(value) {
  if (Array.isArray(value)) {
    return value.map(withoutQueryCoverage);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      key === "queryCoverage" ||
      key === "queryTerms" ||
      key === "queryTermsTruncated"
        ? []
        : [[key, withoutQueryCoverage(entry)]],
    ),
  );
}

function expandIndexes(terms, indexes) {
  return Array.isArray(indexes)
    ? indexes.flatMap((index) =>
        typeof terms[index] === "string" ? [terms[index]] : [],
      )
    : [];
}

function coverageRows(value) {
  const trailing = value?.queryCoverage;
  if (trailing && Array.isArray(trailing.entries)) {
    const terms = Array.isArray(trailing.terms) ? trailing.terms : [];
    return trailing.entries.map((entry) => ({
      address: entry.address,
      nameTerms: expandIndexes(terms, entry.name),
      descriptionTerms: expandIndexes(terms, entry.description),
      unmatchedTerms: expandIndexes(terms, entry.unmatched),
      ...(trailing.truncated ? { truncated: true } : {}),
    }));
  }
  const indexedTerms = Array.isArray(value?.queryTerms)
    ? value.queryTerms
    : [];
  return Array.isArray(value?.connectors)
    ? value.connectors.flatMap((group) =>
        Array.isArray(group.tools)
          ? group.tools.flatMap((tool) => {
              const entry = tool?.queryCoverage;
              if (!entry) return [];
              if (
                Array.isArray(entry.nameTerms) ||
                Array.isArray(entry.descriptionTerms) ||
                Array.isArray(entry.unmatchedTerms)
              ) {
                return [{ address: tool.address, ...entry }];
              }
              return [
                {
                  address: tool.address,
                  nameTerms: expandIndexes(indexedTerms, entry.name),
                  descriptionTerms: expandIndexes(
                    indexedTerms,
                    entry.description,
                  ),
                  unmatchedTerms: expandIndexes(
                    indexedTerms,
                    entry.unmatched,
                  ),
                  ...(value.queryTermsTruncated ? { truncated: true } : {}),
                },
              ];
            })
          : [],
      )
    : [];
}

function resultWithoutQueryCoverage(result) {
  const copy = withoutQueryCoverage(result);
  if (!Array.isArray(copy?.content)) return copy;
  copy.content = copy.content.map((item) => {
    if (item?.type !== "text" || typeof item.text !== "string") return item;
    try {
      return {
        ...item,
        text: JSON.stringify(withoutQueryCoverage(JSON.parse(item.text))),
      };
    } catch {
      return item;
    }
  });
  return copy;
}

export async function runDiscoveryBenchmark(context, corpusPath) {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const cases = [];

  for (const fixture of corpus.queries) {
    const args = {
      query: fixture.query,
      ...(fixture.connector ? { connector: fixture.connector } : {}),
      ...(fixture.limit !== undefined ? { limit: fixture.limit } : {}),
      ...(fixture.offset !== undefined ? { offset: fixture.offset } : {}),
    };
    const { result, observation } = await context.call(
      `holdout:${fixture.id}`,
      "search_tools",
      args,
    );
    const value = structured(result);
    const pageAddresses = addressesFrom(value);
    const relevant = fixture.expectedPage ?? fixture.relevant;
    const relevantSet = new Set(relevant);
    const returnedRelevant = pageAddresses.filter((address) =>
      relevantSet.has(address),
    );
    const positive = relevant.length > 0;
    const defaultPage = fixture.limit === undefined;
    const recall =
      positive ? returnedRelevant.length / relevant.length : pageAddresses.length === 0 ? 1 : 0;
    const precision =
      pageAddresses.length > 0
        ? returnedRelevant.length / pageAddresses.length
        : positive
          ? 0
          : 1;
    const top1 =
      positive && relevantSet.has(pageAddresses[0] ?? "") ? 1 : 0;
    const expectedTop = fixture.expectedTop ?? relevant[0] ?? null;
    const expectedTopMatch =
      expectedTop === null ? null : pageAddresses[0] === expectedTop;
    const falsePositive = !positive && pageAddresses.length > 0;
    const coverage = coverageRows(value);
    const expectedCoverage = fixture.expectedCoverage ?? null;
    const coverageExpectedCorrect =
      expectedCoverage === null
        ? null
        : Object.entries(expectedCoverage).every(([address, expected]) => {
            const actual = coverage.find((entry) => entry.address === address);
            if (!actual) return false;
            const { address: _address, ...actualCoverage } = actual;
            return isDeepStrictEqual(actualCoverage, expected);
          });
    const expectedTopCoverage = coverage.find(
      (entry) => entry.address === expectedTop,
    );
    const coverageDiscriminates =
      expectedTopCoverage !== undefined &&
      expectedTopCoverage.nameTerms.length > 0 &&
      coverage.some(
        (entry) =>
          !relevantSet.has(entry.address) &&
          entry.nameTerms.length === 0 &&
          entry.descriptionTerms.length > 0,
      );
    const responseTokensWithoutCoverage = context.tokens(
      resultWithoutQueryCoverage(result),
    );
    cases.push({
      id: fixture.id,
      category: fixture.category,
      query: fixture.query,
      ...(fixture.connector ? { connector: fixture.connector } : {}),
      relevant,
      pageAddresses,
      total: typeof value?.total === "number" ? value.total : pageAddresses.length,
      returned: pageAddresses.length,
      top1,
      expectedTop,
      expectedTopMatch,
      recall: round(recall, 3),
      recallAtDefaultPage: defaultPage ? round(recall, 3) : null,
      precision: round(precision, 3),
      falsePositive,
      matchMode: value?.matchMode ?? "all",
      hasMore: value?.hasMore === true,
      nextOffset: value?.nextOffset ?? null,
      responseTokens: observation.responseTokens,
      responseTokensWithoutCoverage,
      queryCoverageTokens:
        observation.responseTokens - responseTokensWithoutCoverage,
      queryCoverageRows: coverage.length,
      coverage,
      coverageExpectedCorrect,
      coverageDiscriminates,
      latencyMs: observation.latencyMs,
      passed:
        positive
          ? returnedRelevant.length === relevant.length
          : pageAddresses.length === 0,
    });
  }

  const categories = Object.fromEntries(
    [...new Set(cases.map((entry) => entry.category))].map((category) => {
      const selected = cases.filter((entry) => entry.category === category);
      const positives = selected.filter((entry) => entry.relevant.length > 0);
      const negatives = selected.filter((entry) => entry.relevant.length === 0);
      return [
        category,
        {
          queries: selected.length,
          top1Accuracy:
            positives.length === 0
              ? null
              : round(mean(positives, (entry) => entry.top1), 3),
          expectedTopAccuracy:
            positives.length === 0
              ? null
              : round(
                  mean(
                    positives.filter(
                      (entry) => entry.expectedTopMatch !== null,
                    ),
                    (entry) => (entry.expectedTopMatch ? 1 : 0),
                  ),
                  3,
                ),
          positiveRecall:
            positives.length === 0
              ? null
              : round(mean(positives, (entry) => entry.recall), 3),
          meanPrecision: round(mean(selected, (entry) => entry.precision), 3),
          falsePositiveRate:
            negatives.length === 0
              ? null
              : round(
                  negatives.filter((entry) => entry.falsePositive).length /
                    negatives.length,
                  3,
                ),
          meanResultCount: round(mean(selected, (entry) => entry.returned), 3),
          meanResponseTokens: round(
            mean(selected, (entry) => entry.responseTokens),
            1,
          ),
          meanQueryCoverageTokens: round(
            mean(selected, (entry) => entry.queryCoverageTokens),
            1,
          ),
          meanLatencyMs: round(mean(selected, (entry) => entry.latencyMs), 1),
        },
      ];
    }),
  );
  const positives = cases.filter((entry) => entry.relevant.length > 0);
  const negatives = cases.filter((entry) => entry.relevant.length === 0);
  const defaultPageCases = positives.filter(
    (entry) => entry.recallAtDefaultPage !== null,
  );

  return {
    corpus: {
      schemaVersion: corpus.schemaVersion,
      name: corpus.name,
      authorship: corpus.authorship,
      connectorCount: corpus.connectors.length,
      toolCount: corpus.connectors.reduce(
        (sum, connector) => sum + connector.tools.length,
        0,
      ),
      queryCount: corpus.queries.length,
    },
    metrics: {
      top1Accuracy: round(mean(positives, (entry) => entry.top1), 3),
      expectedTopAccuracy: round(
        mean(
          positives.filter((entry) => entry.expectedTopMatch !== null),
          (entry) => (entry.expectedTopMatch ? 1 : 0),
        ),
        3,
      ),
      positiveRecall: round(mean(positives, (entry) => entry.recall), 3),
      recallAtDefaultPage: round(
        mean(defaultPageCases, (entry) => entry.recallAtDefaultPage),
        3,
      ),
      meanPrecision: round(mean(cases, (entry) => entry.precision), 3),
      falsePositiveRate:
        negatives.length === 0
          ? 0
          : round(
              negatives.filter((entry) => entry.falsePositive).length /
                negatives.length,
              3,
            ),
      meanResultCount: round(mean(cases, (entry) => entry.returned), 3),
      meanResponseTokens: round(
        mean(cases, (entry) => entry.responseTokens),
        1,
      ),
      totalResponseTokens: cases.reduce(
        (sum, entry) => sum + entry.responseTokens,
        0,
      ),
      totalQueryCoverageTokens: cases.reduce(
        (sum, entry) => sum + entry.queryCoverageTokens,
        0,
      ),
      meanQueryCoverageTokens: round(
        mean(cases, (entry) => entry.queryCoverageTokens),
        1,
      ),
      queryCoverageShare: round(
        cases.reduce((sum, entry) => sum + entry.queryCoverageTokens, 0) /
          cases.reduce((sum, entry) => sum + entry.responseTokens, 0),
        3,
      ),
      coverageExpectedChecks: cases.filter(
        (entry) => entry.coverageExpectedCorrect !== null,
      ).length,
      coverageExpectedPassed: cases.filter(
        (entry) => entry.coverageExpectedCorrect === true,
      ).length,
      coverageDiscriminatingCases: cases.filter(
        (entry) => entry.coverageDiscriminates,
      ).length,
      roundTrips: cases.length,
      summedLatencyMs: round(
        cases.reduce((sum, entry) => sum + entry.latencyMs, 0),
        1,
      ),
    },
    categories,
    cases,
  };
}
